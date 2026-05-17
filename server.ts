import mammoth from "mammoth";
import AdmZip from "adm-zip";
import multer from "multer";
import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;
const upload = (multer as any)({ 
  storage: (multer as any).memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Helper to extract text from PPTX
async function extractTextFromPptx(buffer: Buffer): Promise<string> {
  try {
    const zip = new AdmZip(buffer);
    const zipEntries = zip.getEntries();
    let fullText = "";

    // Slides are usually in ppt/slides/slideN.xml
    const slideEntries = zipEntries.filter(entry => entry.entryName.startsWith('ppt/slides/slide') && entry.entryName.endsWith('.xml'));
    
    // Sort slides numerically
    slideEntries.sort((a, b) => {
      const aNum = parseInt(a.entryName.match(/\d+/)?.[0] || "0");
      const bNum = parseInt(b.entryName.match(/\d+/)?.[0] || "0");
      return aNum - bNum;
    });

    for (const entry of slideEntries) {
      const content = entry.getData().toString('utf8');
      // Very crude regex but effective for simple text extraction from PPTX XML
      const matches = content.match(/<a:t>([^<]*)<\/a:t>/g);
      if (matches) {
        fullText += matches.map(m => m.replace(/<a:t>|<\/a:t>/g, '')).join(' ') + "\n";
      }
    }
    return fullText;
  } catch (error) {
    console.error("PPTX Error:", error);
    return "Error parsing PPTX";
  }
}

// API routes go here FIRST
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

app.post("/api/process-files", (req, res, next) => {
  console.log("POST /api/process-files received");
  next();
}, upload.array("files", 100), async (req: any, res) => {
  try {
    const files = req.files;
    console.log(`Multer processed ${files?.length || 0} files`);

    if (!files || files.length === 0) {
      console.log("No files received in request");
      return res.json({ sources: [] });
    }

    const processed: { name: string; content?: string; data?: string; type: string }[] = [];

    for (const file of files) {
      const ext = path.extname(file.originalname).toLowerCase();
      const mime = file.mimetype;
      console.log(`Processing file: ${file.originalname} (${mime})`);

      if (ext === ".pdf" || [".jpg", ".jpeg", ".png"].includes(ext) || [".mp3", ".wav"].includes(ext)) {
        // Multi-modal types are sent as base64 to be handled by Gemini
        processed.push({
          name: file.originalname,
          data: file.buffer.toString("base64"),
          type: mime
        });
      } else if (ext === ".docx") {
        const result = await mammoth.extractRawText({ buffer: file.buffer });
        processed.push({ name: file.originalname, content: result.value, type: "text/plain" });
      } else if (ext === ".pptx") {
        const text = await extractTextFromPptx(file.buffer);
        processed.push({ name: file.originalname, content: text, type: "text/plain" });
      } else if (ext === ".txt" || ext === ".html") {
        processed.push({
          name: file.originalname,
          content: file.buffer.toString("utf8"),
          type: mime
        });
      } else {
        // Fallback for unknown text-like files
        processed.push({
          name: file.originalname,
          content: file.buffer.toString("utf8"),
          type: "text/plain"
        });
      }
    }

    console.log(`Successfully processed ${processed.length} sources`);
    res.json({ sources: processed });
  } catch (error: any) {
    console.error("Process Files Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Helper for exponential backoff
async function retryWithBackoff<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  let lastError: any;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      if (error.message?.includes("429") || error.message?.includes("RESOURCE_EXHAUSTED")) {
        const delay = Math.pow(2, i) * 1000 + Math.random() * 1000;
        console.log(`Gemini Quota met. Retrying in ${Math.round(delay)}ms... (Attempt ${i + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

app.post("/api/generate-cards", async (req, res) => {
  const { sources, count, type, model, detail, existingCards = "", customApiKey } = req.body;
  
  if (!customApiKey) {
    return res.status(401).json({ error: "Gemini API key is required. Please provide your own key in the application settings." });
  }

  // Use ONLY the user-provided API key
  const genAI = new GoogleGenAI({ 
    apiKey: customApiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      }
    }
  });

  // Model selection based on SKILL.md
  let modelName = "gemini-3-flash-preview";
  if (model === "pro") {
    modelName = "gemini-3.1-pro-preview";
  } else if (model === "lite") {
    modelName = "gemini-3.1-flash-lite";
  }

  const isAnalysisOnly = existingCards === "__ANALYZE_COUNT_ONLY__";

  const systemInstruction = isAnalysisOnly 
    ? `You are an expert study planner. Analyze the provided sources and determine the optimal number of Anki flashcards needed to cover the material thoroughly based on the user's coverage preference (${detail}). Return ONLY the number (e.g. 150). Do not generate any cards.`
    : `
    You are an expert Anki card generator. Your task is to process the provided content and generate high-quality Anki flashcards in TSV format.
    
    TSV Format Rules:
    1. Each line is one card: Front [TAB] Back [TAB] Tags
    2. Use <br> for line breaks within fields.
    3. Output Headers:
       #separator:Tab
       #html:true
       #deck:Generated::AnkiIt
       #notetype:Basic
       #columns:Front|Back|Tags

    Customization Rules:
    - Card Type: ${type.join(", ")}
    - Coverage Detail: ${detail} (Detailed = comprehensive, Medium = standard, Shortened = concise)
    - Formatting: If 'fill-in-the-blank' is requested, use _____ for missing words.
    - Points: For question types, you MUST include (/#) at the end of the question indicating how many distinct points of information are expected in the answer (e.g., "What are the 3 laws of motion? (3)").

    Remaining cards to generate: ${count}.
    ${existingCards && existingCards !== "START" ? `CONTINUATION: You have already generated some cards. Continue logically from where you left off based on the source material. DO NOT repeat the previous cards.` : ""}
    
    IMPORTANT: ONLY return the raw TSV data. Do not include markdown blocks or extra text.
  `;

  try {
    const parts: any[] = [{ text: systemInstruction }];
    if (!isAnalysisOnly) {
      parts.push({ text: `Generate cards for the following sources. Batch size target: ${count}.` });
    } else {
      parts.push({ text: `Analyze the following sources and estimate the total flashcard count needed for ${detail} coverage.` });
    }
    
    sources.forEach((s: any) => {
      if (s.data) {
        // Multi-modal part
        parts.push({
          inlineData: {
            mimeType: s.type,
            data: s.data
          }
        });
        parts.push({ text: `Above is source file: ${s.name}` });
      } else if (s.content) {
        parts.push({ text: `Source ${s.name}:\n${s.content}` });
      }
    });

    parts.push({ text: `User request: Generate Anki flashcards for the provided sources. Count: ${count}. Detail: ${detail}. Types: ${type.join(",")}` });

    const response = await retryWithBackoff(() => genAI.models.generateContent({
      model: modelName,
      contents: { parts },
      config: {
        // Move system instruction to part 1 for clarity if needed, or keep here
        // Note: systemInstruction parameter is actually supported in generateContent config or at top level in some SDK versions
        temperature: 0.7,
      },
    }));

    res.json({ content: response.text });
  } catch (error: any) {
    console.error("Gemini Error:", error);
    res.status(error.status || 500).json({ 
      error: error.message,
      code: error.code || "UNKNOWN",
      details: error.details || []
    });
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server is listening on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  });
}

startServer().catch(err => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
