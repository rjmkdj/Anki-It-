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

interface CachedSource {
  content?: string;
  data?: string;
  name: string;
  type: string;
}

// In-memory processed sources cache to save client uploading massive payloads repetitively
const sourceCache = new Map<string, CachedSource>();

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

    const processed: { id: string; name: string; type: string }[] = [];

    for (const file of files) {
      const ext = path.extname(file.originalname).toLowerCase();
      const mime = file.mimetype;
      console.log(`Processing file: ${file.originalname} (${mime})`);

      let content: string | undefined;
      let data: string | undefined;

      if (ext === ".pdf" || [".jpg", ".jpeg", ".png"].includes(ext) || [".mp3", ".wav"].includes(ext)) {
        // Multi-modal types are sent as base64 to be handled by Gemini
        data = file.buffer.toString("base64");
      } else if (ext === ".docx") {
        const result = await mammoth.extractRawText({ buffer: file.buffer });
        content = result.value;
      } else if (ext === ".pptx") {
        content = await extractTextFromPptx(file.buffer);
      } else if (ext === ".txt" || ext === ".html") {
        content = file.buffer.toString("utf8");
      } else {
        // Fallback for unknown text-like files
        content = file.buffer.toString("utf8");
      }

      // Generate stable, unique identifier on the server
      const srcId = `src_${Math.random().toString(36).substring(2, 11)}_${Date.now()}`;

      // Store heavy content & data blocks locally on server
      sourceCache.set(srcId, {
        content,
        data,
        name: file.originalname,
        type: mime || "text/plain"
      });

      // Send ultra-lightweight metadata references back to react frontend
      processed.push({
        id: srcId,
        name: file.originalname,
        type: mime || "text/plain"
      });
    }

    console.log(`Successfully processed ${processed.length} sources and stored in memory`);
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
  const { 
    sources, 
    count, 
    type, 
    model, 
    detail, 
    existingCards = "", 
    customApiKey,
    currentBatch = 0,
    totalBatches = 1
  } = req.body;
  
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

  // Conceptual/sequential segmented target instructions for pure "divide and conquer" mathematically
  let segmentInstruction = "";
  if (!isAnalysisOnly && totalBatches > 1) {
    const startPct = Math.round((currentBatch / totalBatches) * 100);
    const endPct = Math.round(((currentBatch + 1) / totalBatches) * 100);
    segmentInstruction = `
    
    --------------------------------------------------
    DEVELOPER CONTENT SEGMENTATION MANDATE (MATHEMATICAL SLICING ALGORITHM):
    This is card generation batch ${currentBatch + 1} of ${totalBatches}.
    You MUST focus your card generation strictly and exclusively on the concepts, topics, and details located within the sequential ${startPct}% to ${endPct}% content section of the source assets.
    Do NOT overlap, duplicate, or generate any card questions that would cover content outside of this ${startPct}% to ${endPct}% sequential territory.
    Compose ${count} brand-new, unique Anki flashcards for this specific zone.
    --------------------------------------------------
    `;
  }

  const systemInstruction = isAnalysisOnly 
    ? `You are an expert study planner. Analyze the provided sources and determine the optimal number of Anki flashcards needed to cover the material thoroughly based on the user's coverage preference (${detail}). Return ONLY the number (e.g. 150). Do not generate any cards.`
    : `
    You are an expert Anki card generator. Your task is to process the provided content and generate high-quality Anki flashcards.
    
    ${segmentInstruction}

    Strict Format Rules:
    1. Each line MUST be exactly: Front [TAB] Back
    2. Do NOT include a Tags column unless explicitly requested.
    3. Use <br> for line breaks within fields.
    4. Output MUST start with these headers exactly:
       #separator:tab
       #html:true
       #notetype:Basic
       #deck:AnkiIt::[TOPIC_NAME] (Replace [TOPIC_NAME] with a descriptive title for this material)

    Strict Format Rules:
    1. Each line MUST be exactly: Front [TAB] Back
    2. No headers other than the ones listed above.
    3. Use <br> for line breaks within fields.
    4. Escape any raw tabs or HTML that would break the TSV structure.

    Remaining cards to generate in this batch: ${count}.
    ${existingCards && existingCards !== "START" ? `CONTINUATION NOTES: You have already generated previous card batches. Continue smoothly, do not repeat questions already asked.` : ""}
    
    IMPORTANT: ONLY return the raw TSV data. Do not include markdown codeblocks like \`\`\`tsv or extra conversational text. Start outputting card lines directly.
  `;

  try {
    const parts: any[] = [{ text: systemInstruction }];
    if (!isAnalysisOnly) {
      parts.push({ text: `Generate cards for the following sources. Batch size target: ${count}.` });
    } else {
      parts.push({ text: `Analyze the following sources and estimate the total flashcard count needed for ${detail} coverage.` });
    }
    
    // Dynamically retrieve stored heavy source data from our in-memory cache
    const resolvedSources = (sources || []).map((s: any) => {
      const cached = sourceCache.get(s.id);
      if (cached) {
        return {
          name: s.name,
          type: s.type,
          content: cached.content || undefined,
          data: cached.data || undefined
        };
      }
      return s; // Keep original if pasted or not cached
    });

    resolvedSources.forEach((s: any) => {
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
