/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef, useEffect } from "react";
import { 
  Plus, 
  Upload, 
  FileText, 
  Youtube, 
  Trash2, 
  Settings2, 
  Sparkles, 
  Download, 
  ChevronRight,
  FileUp,
  X,
  FileCheck,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Clapperboard,
  LogOut
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "./lib/utils";
import { GoogleAd } from "./components/GoogleAd";
import { db, auth, handleFirestoreError, OperationType } from "./lib/firebase";
import { onAuthStateChanged, signInWithPopup, signOut, GoogleAuthProvider, User } from "firebase/auth";
import { 
  collection, 
  addDoc, 
  setDoc,
  doc,
  serverTimestamp, 
  getDoc, 
  writeBatch,
  query,
  where,
  orderBy,
  onSnapshot
} from "firebase/firestore";

// Types
interface Source {
  id: string;
  name: string;
  type: string;
  content?: string;
  data?: string;
}

type ModelType = "lite" | "flash" | "pro";
type DetailLevel = "shortened" | "medium" | "detailed";
type CardType = "qa" | "fill";

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [textInput, setTextInput] = useState("");
  
  // Options
  const [cardCount, setCardCount] = useState(50);
  const [selectedCardTypes, setSelectedCardTypes] = useState<CardType[]>(["qa"]);
  const [selectedModel, setSelectedModel] = useState<ModelType>("flash");
  const [detailLevel, setDetailLevel] = useState<DetailLevel>("medium");
  
  // Progress & Result
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationProgress, setGenerationProgress] = useState(0);
  const [generatedContent, setGeneratedContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [customApiKey, setCustomApiKey] = useState(() => localStorage.getItem("gemini_api_key") || "");
  const [quotaExceeded, setQuotaExceeded] = useState(false);
  const [isKeySaving, setIsKeySaving] = useState(false);

  // Terms and Conditions State
  const [hasAcceptedTerms, setHasAcceptedTerms] = useState(() => localStorage.getItem("anki_it_terms_accepted") === "true");
  const [showTermsModal, setShowTermsModal] = useState(false);

  const acceptTerms = () => {
    localStorage.setItem("anki_it_terms_accepted", "true");
    setHasAcceptedTerms(true);
    setShowTermsModal(false);
  };

  useEffect(() => {
    if (customApiKey) {
      localStorage.setItem("gemini_api_key", customApiKey);
    }
  }, [customApiKey]);
  
  const logout = async () => {
    try {
      await signOut(auth);
      setSources([]);
      setGeneratedContent("");
    } catch (err) {
      console.error("Logout error:", err);
    }
  };

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u) {
        // Sync user profile
        try {
          const userRef = doc(db, "users", u.uid);
          const userSnap = await getDoc(userRef);
          if (!userSnap.exists()) {
            await setDoc(userRef, {
              uid: u.uid,
              email: u.email,
              displayName: u.displayName,
              photoURL: u.photoURL,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp()
            });
          }
        } catch (err) {
          console.error("Profile sync error:", err);
        }
      }
    });
  }, []);

  const login = async () => {
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (err) {
      console.error(err);
      setError("Login failed. Please try again.");
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    console.log("File upload triggered, files count:", files?.length || 0);
    if (!files || files.length === 0) return;

    setIsUploading(true);
    const formData = new FormData();
    Array.from(files).forEach(file => {
      console.log("Appending file to FormData:", file.name, file.type, file.size);
      formData.append("files", file);
    });

    try {
      console.log("Sending POST request to /api/process-files");
      const response = await fetch("/api/process-files", {
        method: "POST",
        body: formData,
      });
      
      console.log("Response received, status:", response.status);
      const data = await response.json();
      if (data.error) {
        console.error("Server returned error:", data.error);
        throw new Error(data.error);
      }

      console.log("Files processed successfully, sources count:", data.sources.length);
      const newSources = data.sources.map((s: any) => ({
        id: s.id, // Use the server-assigned in-memory source cache ID
        name: s.name,
        type: s.type,
        content: s.content,
        data: s.data
      }));
      setSources(prev => [...prev, ...newSources]);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsUploading(false);
    }
  };

  const handleTextPaste = () => {
    if (!textInput) return;
    setSources(prev => [...prev, {
      id: Math.random().toString(36).substr(2, 9),
      name: "Pasted Text " + (prev.length + 1),
      type: "text",
      content: textInput
    }]);
    setTextInput("");
  };

  const removeSource = (id: string) => {
    setSources(prev => prev.filter(s => s.id !== id));
  };

  const analyzeOptimalCount = async () => {
    if (sources.length === 0) return;
    setIsAnalyzing(true);
    setError(null);
    try {
      const res = await fetch("/api/generate-cards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sources,
          count: 0, // indicates analysis mode
          type: selectedCardTypes,
          model: selectedModel,
          detail: detailLevel,
          existingCards: "__ANALYZE_COUNT_ONLY__",
          customApiKey: customApiKey || undefined
        })
      });
      const data = await res.json();
      if (data.error) {
        if (data.code === "RESOURCE_EXHAUSTED" || (typeof data.error === 'string' && data.error.includes("429"))) {
          setQuotaExceeded(true);
        }
        throw new Error(data.error);
      }
      if (!data || !data.content) throw new Error("AI analysis failed to return an estimate.");
      
      const countMatch = data.content.match(/\d+/);
      if (countMatch) {
        const estimated = Math.min(3000, Math.max(1, parseInt(countMatch[0])));
        setCardCount(estimated);
      }
    } catch (err: any) {
      console.error(err);
      setError("Failed to analyze content volume: " + err.message);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const startGeneration = async () => {
    if (!user) {
      login();
      return;
    }
    if (sources.length === 0) return;

    setIsGenerating(true);
    setGenerationProgress(5);
    setError(null);
    setGeneratedContent("");

    let allGenerated = "";
    const batchSize = 100; // Generate in batches to handle token limits and ensure "infinite" feel
    const iterations = Math.ceil(cardCount / batchSize);

    try {
      for (let i = 0; i < iterations; i++) {
        const remainingToGen = cardCount - (i * batchSize);
        const currentBatchSize = Math.min(batchSize, remainingToGen);
        
        setGenerationProgress(Math.floor((i / iterations) * 100));

        const response = await fetch("/api/generate-cards", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sources,
            count: currentBatchSize,
            type: selectedCardTypes,
            model: selectedModel,
            detail: detailLevel,
            existingCards: allGenerated || "START",
            customApiKey: customApiKey || undefined,
            currentBatch: i,
            totalBatches: iterations
          }),
        });

        const data = await response.json();
        if (data.error) {
          if (data.code === "RESOURCE_EXHAUSTED" || (typeof data.error === 'string' && data.error.includes("429"))) {
            setQuotaExceeded(true);
          }
          throw new Error(data.error);
        }

        // Append content (strip headers if not the first batch)
        let chunk = data.content || "";
        if (allGenerated.length > 0) {
          // Keep only card lines (lines that do not start with '#') to avoid duplicative header lines
          const lines = chunk.split("\n").filter((line: string) => !line.trim().startsWith("#"));
          chunk = lines.join("\n") + "\n";
        }
        allGenerated += chunk;
      }

      setGeneratedContent(allGenerated);
      setGenerationProgress(100);

    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsGenerating(false);
    }
  };

  const downloadTsv = () => {
    let filename = "Anki_Flashcards";
    if (sources.length > 0) {
      const firstSource = sources[0].name.replace(/\.[^/.]+$/, ""); // strip extension
      filename = firstSource.replace(/[^a-z0-9]/gi, '_').substring(0, 50);
    }
    const blob = new Blob([generatedContent], { type: "text/tab-separated-values" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${filename}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-[#FDFCFB] text-[#1D1B19] font-sans selection:bg-[#E4E3E0] selection:text-[#141414]">
      {/* Terms and Conditions Modal (Blocking) */}
      <AnimatePresence>
        {(!hasAcceptedTerms || showTermsModal) && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[110] bg-[#FDFCFB]/95 flex items-center justify-center p-6 backdrop-blur-md"
          >
            <div className="max-w-2xl w-full max-h-[80vh] flex flex-col bg-white border border-[#E4E3E0] rounded-3xl shadow-2xl overflow-hidden">
              <div className="p-8 border-b border-[#E4E3E0] flex items-center justify-between">
                <div>
                  <h3 className="text-xl font-bold tracking-tight">Terms and Conditions</h3>
                  <p className="text-[10px] text-[#8E9299] uppercase font-mono mt-1">Please read carefully before continuing</p>
                </div>
                {hasAcceptedTerms && (
                  <button onClick={() => setShowTermsModal(false)} className="p-2 hover:bg-[#F8F7F6] rounded-full transition-colors">
                    <X className="w-5 h-5 text-[#8E9299]" />
                  </button>
                )}
              </div>
              
              <div className="flex-1 overflow-y-auto p-8 thin-scrollbar">
                <div className="prose prose-sm prose-stone">
                  <pre className="text-xs font-sans leading-relaxed text-[#5B5753] whitespace-pre-wrap">
                    {`Anki It! Terms of Service
Last Updated: May 17, 2026

1. Acceptance of Terms
By accessing or using the Anki It! web application ("Service"), you agree to be bound by these Terms of Service. If you do not agree to all of these terms, do not use the Service.

2. Description of Service
Anki It! is an AI-powered educational tool that converts uploaded documents, text, and other media into flashcard formats compatible with Anki and other spaced-repetition systems.

3. Privacy & Data Handling
- Your source documents are processed by third-party AI models (Google Gemini).
- We do not store your source files permanently.
- You are responsible for ensuring you have the legal right to upload and process the content you provide.

4. Usage Limits & API Keys
- The service may impose rate limits.
- If you provide a personal API key, it is stored locally in your browser and used only for your requests.

5. Accuracy of AI Content
Generating flashcards involves Artificial Intelligence. We do not guarantee the factual accuracy, completeness, or suitability of the generated cards. Always verify study material against primary sources.

6. Prohibited Use
You agree not to use the Service for any illegal activities, to process sensitive personal data, or to circumvent any platform security measures.

7. Disclaimer of Warranties
THE SERVICE IS PROVIDED "AS IS" WITHOUT WARRANTY OF ANY KIND. WE ARE NOT LIABLE FOR ANY ACADEMIC OUTCOMES OR DATA LOSS.`}
                  </pre>
                </div>
              </div>

              <div className="p-8 border-t border-[#E4E3E0] bg-[#F8F7F6]">
                {!hasAcceptedTerms ? (
                  <button 
                    onClick={acceptTerms}
                    className="w-full py-4 bg-[#1D1B19] text-[#FDFCFB] font-bold rounded-xl hover:bg-[#322F2C] transition-all flex items-center justify-center gap-2"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    I AGREE TO THE TERMS AND CONDITIONS
                  </button>
                ) : (
                  <button 
                    onClick={() => setShowTermsModal(false)}
                    className="w-full py-4 border border-[#1D1B19] text-[#1D1B19] font-bold rounded-xl hover:bg-[#1D1B19] hover:text-[#FDFCFB] transition-all"
                  >
                    CLOSE
                  </button>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {/* Header */}
      <header className="sticky top-0 z-50 bg-[#FDFCFB]/80 backdrop-blur-md border-b border-[#E4E3E0] px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#1D1B19] flex items-center justify-center rounded-lg">
              <Sparkles className="w-6 h-6 text-[#FDFCFB]" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight">Anki It!</h1>
              <p className="text-xs text-[#8E9299] font-mono uppercase tracking-wider">Flashcard AI Engine</p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            {user ? (
              <div className="flex items-center gap-3 pr-2">
                <div className="text-right hidden sm:block">
                  <p className="text-xs font-semibold">{user.displayName || user.email}</p>
                </div>
                <img 
                  src={user.photoURL || `https://ui-avatars.com/api/?name=${user.email}`} 
                  className="w-8 h-8 rounded-full border border-[#E4E3E0]" 
                  referrerPolicy="no-referrer"
                />
                <button 
                  onClick={logout}
                  className="p-1.5 hover:bg-red-50 text-[#8E9299] hover:text-red-500 rounded-full transition-colors"
                  title="Sign Out"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <button 
                onClick={login}
                className="px-4 py-2 bg-[#1D1B19] text-[#FDFCFB] text-sm font-medium rounded-full hover:bg-[#322F2C] transition-colors"
                id="login-button"
              >
                Sign In
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-12 relative">
        {/* API Key Gateway */}
        <AnimatePresence>
          {!customApiKey && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[100] bg-[#FDFCFB]/95 flex items-center justify-center p-6 backdrop-blur-sm"
            >
              <div className="max-w-md w-full p-8 bg-white border border-[#E4E3E0] rounded-3xl shadow-2xl space-y-6">
                <div className="w-16 h-16 bg-[#1D1B19] flex items-center justify-center rounded-2xl mx-auto mb-4">
                  <Sparkles className="w-8 h-8 text-[#FDFCFB]" />
                </div>
                <div className="text-center space-y-2">
                  <h3 className="text-2xl font-bold tracking-tight">API Activation Required</h3>
                  <p className="text-sm text-[#5B5753]">To use Anki It!, provide your own Gemini API key. This ensures high-speed generation and bypasses shared limits.</p>
                </div>

                <div className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-[10px] font-bold uppercase tracking-widest text-[#8E9299]">Your Gemini API Key</label>
                    <input 
                      type="password"
                      placeholder="Paste AI Studio key here (AI_...)"
                      className="w-full bg-[#F8F7F6] border border-[#E4E3E0] px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-[#1D1B19] transition-all"
                      id="initial-key-input"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          const val = (e.target as HTMLInputElement).value;
                          if (val.startsWith("AI")) setCustomApiKey(val);
                        }
                      }}
                    />
                  </div>
                  <button 
                    onClick={() => {
                      const input = document.getElementById('initial-key-input') as HTMLInputElement;
                      if (input.value.startsWith("AI")) {
                         setCustomApiKey(input.value);
                      } else {
                         setError("Please enter a valid Gemini API key starting with 'AI'");
                         setTimeout(() => setError(null), 3000);
                      }
                    }}
                    className="w-full py-4 bg-[#1D1B19] text-[#FDFCFB] font-bold rounded-xl hover:bg-[#322F2C] transition-all"
                  >
                    ACTIVATE ENGINE
                  </button>
                  <p className="text-[10px] text-center text-[#8E9299]">
                    Get a free key at <a href="https://aistudio.google.com/app/apikey" target="_blank" className="underline hover:text-[#1D1B19]">aistudio.google.com</a>
                  </p>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Intro */}
        <section className="mb-16">
          <motion.h2 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-4xl sm:text-5xl font-bold tracking-tighter mb-4"
          >
            Turn anything into <br />
            <span className="text-[#8E9299]">perfect Anki study sets.</span>
          </motion.h2>
          <motion.p 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="text-lg text-[#5B5753] max-w-2xl leading-relaxed"
          >
            Upload PDFs, documents, YouTube videos, or images. Our AI extracts core concepts and formats them for immediate Anki import.
          </motion.p>
        </section>

        <div className="grid grid-cols-1 gap-12">
          {/* Top Banner Ad */}
          <GoogleAd slot="7622282839" className="mt-8" />

          {/* Uploader Section */}
          <section className="space-y-6">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Plus className="w-4 h-4" />
                <h3 className="text-xs font-bold uppercase tracking-widest text-[#8E9299]">Step 1: Add Sources</h3>
              </div>
              <span className="text-[10px] bg-[#E4E3E0] text-[#5B5753] px-2 py-0.5 rounded font-bold uppercase tracking-tighter">No credits used for upload</span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* File Dropzone */}
              <div 
                onClick={() => fileInputRef.current?.click()}
                className="group relative border-2 border-dashed border-[#E4E3E0] rounded-2xl p-8 flex flex-col items-center justify-center cursor-pointer hover:border-[#1D1B19] hover:bg-[#F8F7F6] transition-all duration-300"
                id="file-dropzone"
              >
                <input 
                  type="file" 
                  ref={fileInputRef} 
                  multiple 
                  onChange={handleFileUpload} 
                  className="hidden"
                  accept=".pdf,.docx,.pptx,.txt,.html,.jpg,.jpeg,.png,.mp3,.wav"
                />
                <div className="w-12 h-12 bg-[#F8F7F6] group-hover:bg-[#1D1B19] flex items-center justify-center rounded-xl mb-4 transition-colors">
                  {isUploading ? (
                    <Loader2 className="w-6 h-6 animate-spin text-[#1D1B19] group-hover:text-[#FDFCFB]" />
                  ) : (
                    <FileUp className="w-6 h-6 text-[#1D1B19] group-hover:text-[#FDFCFB]" />
                  )}
                </div>
                <p className="text-sm font-semibold mb-1">Click to upload files</p>
                <p className="text-xs text-[#8E9299]">PDF, DOCX, PPTX, Images (OCR), Audio</p>
              </div>

              {/* Text Input */}
              <div className="flex flex-col gap-4">
                <div className="p-1 bg-[#F8F7F6] border border-[#E4E3E0] rounded-2xl">
                  <div className="flex flex-col p-3">
                    <textarea 
                      placeholder="Paste transcription, notes, or raw text here..."
                      className="w-full h-32 bg-transparent text-sm focus:outline-none resize-none placeholder-[#8E9299]"
                      value={textInput}
                      onChange={(e) => setTextInput(e.target.value)}
                      id="text-paste-input"
                    />
                    <div className="flex justify-end pt-2">
                       <button 
                        onClick={handleTextPaste}
                        disabled={!textInput}
                        className="flex items-center gap-1.5 px-3 py-1 text-[#1D1B19] text-xs font-bold hover:bg-[#E4E3E0] rounded-lg transition-colors"
                        id="paste-button"
                      >
                        <Plus className="w-3 h-3" /> PASTE TEXT
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Selected Sources List */}
            <AnimatePresence>
              {sources.length > 0 && (
                <motion.div 
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="space-y-2"
                >
                  <p className="text-[10px] font-bold text-[#8E9299] uppercase tracking-wider pl-1">Sources ({sources.length}/100)</p>
                  <div className="max-h-48 overflow-y-auto pr-2 space-y-2 thin-scrollbar">
                    {sources.map((s) => (
                      <div key={s.id} className="flex items-center justify-between p-3 bg-white border border-[#E4E3E0] rounded-xl hover:border-[#1D1B19] transition-colors group">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-lg bg-[#F8F7F6] flex items-center justify-center">
                            {s.type.includes("youtube") ? <Youtube className="w-4 h-4 text-red-500" /> : 
                             s.type.includes("image") ? <Plus className="w-4 h-4 text-green-500" /> :
                             s.type.includes("audio") ? <Settings2 className="w-4 h-4 text-purple-500" /> :
                             <FileText className="w-4 h-4 text-blue-500" />}
                          </div>
                          <div>
                            <p className="text-sm font-medium truncate max-w-[200px]">{s.name}</p>
                            <p className="text-[10px] text-[#8E9299] uppercase">{s.type.split('/')[1] || s.type}</p>
                          </div>
                        </div>
                        <button onClick={() => removeSource(s.id)} className="p-2 text-[#8E9299] hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </section>

          {/* Configuration Section */}
          <section className={cn("p-8 rounded-3xl border border-[#E4E3E0] bg-white transition-opacity", sources.length === 0 ? "opacity-30 pointer-events-none" : "opacity-100")}>
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-10">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Settings2 className="w-4 h-4" />
                  <h3 className="text-xs font-bold uppercase tracking-widest text-[#8E9299]">Step 2: Configuration</h3>
                </div>
                <p className="text-sm font-medium">Fine-tune your flashcard generation</p>
              </div>
              
              <div className="flex flex-col items-end gap-1">
                <button 
                  onClick={analyzeOptimalCount}
                  disabled={isAnalyzing || isGenerating || sources.length === 0}
                  className="flex items-center gap-2 px-4 py-2 bg-[#F8F7F6] border border-[#E4E3E0] text-xs font-bold rounded-xl hover:border-[#1D1B19] transition-all disabled:opacity-50"
                  id="analyze-optimal-button"
                >
                  {isAnalyzing ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="w-3.5 h-3.5" />
                  )}
                  AI ANALYZE CONTENT VOLUME
                </button>
                <span className="text-[9px] text-[#8E9299] flex items-center gap-1 font-mono">
                  <AlertCircle className="w-2.5 h-2.5" /> USES AI CREDITS
                </span>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
              {/* Card Count & Types */}
              <div className="space-y-8">
                <div>
                  <div className="flex justify-between items-end mb-4">
                    <label className="text-sm font-semibold">Number of Cards</label>
                    <span className="text-2xl font-bold font-mono">{cardCount}</span>
                  </div>
                  <input 
                    type="range" 
                    min="1" 
                    max="3000" 
                    value={cardCount} 
                    onChange={(e) => setCardCount(parseInt(e.target.value))}
                    className="w-full h-1.5 bg-[#E4E3E0] rounded-lg appearance-none cursor-pointer accent-[#1D1B19]"
                    id="card-count-slider"
                  />
                  <div className="flex justify-between text-[10px] text-[#8E9299] mt-2 font-mono uppercase">
                    <span>1 CARD</span>
                    <span>3000 MAX</span>
                  </div>
                </div>

                <div>
                  <label className="text-sm font-semibold mb-3 block">Flashcard Types</label>
                  <div className="grid grid-cols-1 gap-2">
                    {[
                      { id: 'qa', label: 'Questions with Answers', desc: 'Standard Q&A with point indicators' },
                      { id: 'fill', label: 'Fill in the Blanks', desc: 'Cloze deletion style using _____' }
                    ].map((t) => (
                      <label 
                        key={t.id}
                        className={cn(
                          "relative flex items-start gap-3 p-4 border rounded-2xl cursor-pointer transition-all",
                          selectedCardTypes.includes(t.id as CardType) ? "border-[#1D1B19] bg-[#F8F7F6]" : "border-[#E4E3E0] hover:border-[#8E9299]"
                        )}
                      >
                        <input 
                          type="checkbox" 
                          hidden 
                          checked={selectedCardTypes.includes(t.id as CardType)}
                          onChange={() => {
                            if (selectedCardTypes.includes(t.id as CardType)) {
                              if (selectedCardTypes.length > 1) setSelectedCardTypes(prev => prev.filter(x => x !== t.id));
                            } else {
                              setSelectedCardTypes(prev => [...prev, t.id as CardType]);
                            }
                          }}
                        />
                        <div className={cn("w-5 h-5 mt-0.5 rounded border flex items-center justify-center transition-colors", selectedCardTypes.includes(t.id as CardType) ? "bg-[#1D1B19] border-[#1D1B19]" : "bg-white border-[#E4E3E0]")}>
                          <CheckCircle2 className={cn("w-3.5 h-3.5 text-white", !selectedCardTypes.includes(t.id as CardType) && "hidden")} />
                        </div>
                        <div>
                          <p className="text-sm font-bold">{t.label}</p>
                          <p className="text-xs text-[#8E9299] leading-tight">{t.desc}</p>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              </div>

              {/* Model & Depth */}
              <div className="space-y-10">
                <div className="space-y-4">
                  <label className="text-sm font-semibold">Select AI Model</label>
                  <div className="flex bg-[#F8F7F6] p-1 rounded-2xl border border-[#E4E3E0]">
                    {[
                      { id: 'lite', label: 'LITE', speed: 'Ultra Fast' },
                      { id: 'flash', label: 'FLASH', speed: 'Fast' },
                      { id: 'pro', label: 'PRO', speed: 'Advanced' }
                    ].map((m) => (
                      <button
                        key={m.id}
                        onClick={() => setSelectedModel(m.id as ModelType)}
                        className={cn(
                          "flex-1 py-3 px-4 rounded-xl text-xs font-bold transition-all",
                          selectedModel === m.id ? "bg-[#1D1B19] text-[#FDFCFB] shadow-lg" : "text-[#8E9299] hover:text-[#1D1B19]"
                        )}
                        id={`model-select-${m.id}`}
                      >
                        {m.label}
                        <span className="block text-[8px] opacity-70 mt-0.5">{m.speed}</span>
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-[#8E9299] mt-1 italic pl-1">
                    * PRO function requires a paid Google Cloud project key with billing enabled.
                  </p>
                </div>

                <div className="space-y-4">
                  <label className="text-sm font-semibold">Coverage Detail</label>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { id: 'shortened', label: 'Short', desc: 'Concise' },
                      { id: 'medium', label: 'Medium', desc: 'Balanced' },
                      { id: 'detailed', label: 'Detailed', desc: 'Full' }
                    ].map((d) => (
                      <button
                        key={d.id}
                        onClick={() => setDetailLevel(d.id as DetailLevel)}
                        className={cn(
                          "flex flex-col items-center py-4 px-2 border rounded-2xl transition-all",
                          detailLevel === d.id ? "border-[#1D1B19] bg-[#F8F7F6] shadow-sm" : "border-[#E4E3E0] hover:border-[#8E9299]"
                        )}
                        id={`detail-select-${d.id}`}
                      >
                        <span className="text-xs font-bold">{d.label}</span>
                        <span className="text-[9px] text-[#8E9299] uppercase tracking-wide mt-1">{d.desc}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="pt-4 space-y-4">
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <label className="text-[10px] font-bold uppercase tracking-widest text-[#8E9299]">Gemini API Key (Locked)</label>
                      <button 
                        onClick={() => {
                          localStorage.removeItem("gemini_api_key");
                          setCustomApiKey("");
                        }}
                        className="text-[9px] underline text-red-500 hover:text-red-700 uppercase font-bold"
                      >
                        RESET KEY
                      </button>
                    </div>
                    <div className="flex items-center gap-2 bg-[#F8F7F6] border border-[#E4E3E0] px-3 py-2 rounded-xl">
                      <CheckCircle2 className="w-3 h-3 text-green-500" />
                      <input 
                        type="password"
                        readOnly
                        value="••••••••••••••••••••"
                        className="flex-1 bg-transparent text-[10px] focus:outline-none"
                      />
                    </div>
                  </div>

                  <button 
                    onClick={startGeneration}
                    disabled={isGenerating || sources.length === 0}
                    className="w-full group relative overflow-hidden bg-[#1D1B19] text-[#FDFCFB] py-5 px-6 rounded-2xl font-bold flex items-center justify-center gap-3 hover:bg-[#322F2C] transition-all shadow-xl shadow-[#1D1B19]/10 disabled:opacity-50"
                    id="generate-button"
                  >
                    {isGenerating ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin" />
                        GENERATING {cardCount} CARDS...
                      </>
                    ) : (
                      <>
                        GENERATE ANKI CARDS
                        <ChevronRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </section>

          {/* Middle Banner Ad */}
          <GoogleAd slot="4996119493" format="rectangle" />

          {/* Result Section */}
          <AnimatePresence>
            {(isGenerating || generatedContent || error) && (
              <motion.section 
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 20 }}
                className="p-8 rounded-3xl border border-[#E4E3E0] bg-[#FDFCFB]"
              >
                {/* Progress */}
                {isGenerating && (
                  <div className="space-y-6 mb-10">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin text-[#1D1B19]" />
                        <h3 className="text-xs font-bold uppercase tracking-widest">Processing Content</h3>
                      </div>
                      <span className="text-xs font-mono font-bold text-[#8E9299]">{generationProgress}%</span>
                    </div>
                    <div className="w-full h-2 bg-[#F8F7F6] rounded-full overflow-hidden">
                      <motion.div 
                        className="h-full bg-[#1D1B19]" 
                        initial={{ width: 0 }}
                        animate={{ width: `${generationProgress}%` }}
                      />
                    </div>
                    <p className="text-xs text-[#8E9299] font-mono italic">"Dividing tasks, processing chunks, formatting TSV..."</p>
                  </div>
                )}

                {error && (
                  <div className={cn(
                    "p-6 border rounded-2xl flex flex-col gap-4 mb-6",
                    quotaExceeded ? "bg-orange-50 border-orange-100 text-orange-800" : "bg-red-50 border-red-100 text-red-600"
                  )}>
                    <div className="flex items-start gap-3">
                      <AlertCircle className="w-5 h-5 mt-0.5" />
                      <div className="flex-1">
                        <p className="text-sm font-bold">
                          {quotaExceeded ? "Temporary Quota Limitation" : "Generation Error"}
                        </p>
                        <p className="text-xs opacity-90">
                          {quotaExceeded 
                            ? "We've reached the free generation limit for this period. You can wait a few minutes, or use your own Gemini API key to continue immediately."
                            : error}
                        </p>
                      </div>
                    </div>

                    {quotaExceeded && (
                      <div className="mt-2 space-y-3">
                        <div className="flex flex-col gap-2">
                          <label className="text-[10px] font-bold uppercase tracking-widest opacity-70">
                            Your Personal Gemini API Key
                          </label>
                          <div className="flex gap-2">
                            <input 
                              type="password"
                              placeholder="Paste your API key here..."
                              className="flex-1 bg-white/50 border border-orange-200 px-3 py-2 rounded-xl text-xs focus:outline-none focus:border-orange-400"
                              value={customApiKey}
                              onChange={(e) => setCustomApiKey(e.target.value)}
                            />
                            <button 
                              onClick={() => {
                                setError(null);
                                setQuotaExceeded(false);
                                startGeneration();
                              }}
                              className="px-4 py-2 bg-orange-600 text-white text-xs font-bold rounded-xl hover:bg-orange-700 transition-colors shadow-sm"
                            >
                              RESUME
                            </button>
                          </div>
                        </div>
                        <p className="text-[10px] opacity-60">
                          You can get your own key for free at <a href="https://aistudio.google.com/app/apikey" target="_blank" className="underline">aistudio.google.com</a>. Your key is only used for this session and is never stored on our servers.
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {generatedContent && (
                  <div className="space-y-6">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <FileCheck className="w-4 h-4 text-green-500" />
                        <h3 className="text-xs font-bold uppercase tracking-widest">Generated Output</h3>
                      </div>
                      <button 
                        onClick={downloadTsv}
                        className="flex items-center gap-2 px-4 py-2 bg-[#1D1B19] text-[#FDFCFB] text-xs font-bold rounded-xl hover:bg-[#322F2C] transition-all"
                        id="download-button"
                      >
                        <Download className="w-3.5 h-3.5" /> DOWNLOAD .TXT FOR ANKI
                      </button>
                    </div>

                    <div className="bg-[#1D1B19] rounded-2xl p-6 overflow-hidden">
                      <div className="flex items-center justify-between mb-4 border-b border-white/10 pb-3">
                        <span className="text-[10px] text-white/50 font-mono uppercase tracking-widest">Preview (TSV Format)</span>
                        <div className="flex gap-1">
                          <div className="w-2 h-2 rounded-full bg-red-500/50" />
                          <div className="w-2 h-2 rounded-full bg-yellow-500/50" />
                          <div className="w-2 h-2 rounded-full bg-green-500/50" />
                        </div>
                      </div>
                      <div className="max-h-64 overflow-y-auto thin-scrollbar-dark">
                        <pre className="text-[11px] text-[#FDFCFB]/90 font-mono leading-relaxed whitespace-pre-wrap">
                          {generatedContent}
                        </pre>
                      </div>
                    </div>

                    <div className="p-6 bg-[#F8F7F6] rounded-2xl border border-[#E4E3E0] space-y-4">
                      <h4 className="text-sm font-bold flex items-center gap-2">
                        <Download className="w-4 h-4" /> How to import into Anki?
                      </h4>
                      <ol className="text-xs text-[#5B5753] space-y-2 list-decimal list-inside leading-loose">
                        <li>Download the <span className="font-bold text-[#1D1B19]">.txt</span> file using the button above.</li>
                        <li>Open Anki on your desktop and click <span className="font-bold text-[#1D1B19]">Import File</span>.</li>
                        <li>Select the downloaded file.</li>
                        <li>Anki will automatically recognize the headers (Tabs, IDs, Tags).</li>
                        <li>Click <span className="font-bold text-[#1D1B19]">Import</span> and start studying!</li>
                      </ol>
                    </div>
                  </div>
                )}
              </motion.section>
            )}
          </AnimatePresence>
        </div>
      </main>

      <footer className="max-w-4xl mx-auto px-6 py-12 border-t border-[#E4E3E0] flex flex-col sm:flex-row items-center justify-between gap-6 opacity-30">
        <p className="text-xs font-mono uppercase tracking-widest">Anki It! © 2026</p>
        <div className="flex gap-6">
          <button onClick={() => setShowTermsModal(true)} className="text-xs font-bold hover:text-[#1D1B19] uppercase tracking-wider">TERMS & CONDITIONS</button>
        </div>
      </footer>

      {/* Global CSS for scrollbars */}
      <style>{`
        .thin-scrollbar::-webkit-scrollbar { width: 4px; }
        .thin-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .thin-scrollbar::-webkit-scrollbar-thumb { background: #E4E3E0; border-radius: 10px; }
        
        .thin-scrollbar-dark::-webkit-scrollbar { width: 4px; }
        .thin-scrollbar-dark::-webkit-scrollbar-track { background: transparent; }
        .thin-scrollbar-dark::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 10px; }
      `}</style>
    </div>
  );
}
