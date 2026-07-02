import { GoogleGenAI } from "@google/genai";

const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;

if (!apiKey) {
    console.error("❌ No API key found!");
    process.exit(1);
}

async function listModels() {
    try {
        const ai = new GoogleGenAI({ apiKey });
        
        console.log("📋 Fetching available models...\n");
        
        const models = await ai.models.list();
        
        console.log("Available Models:");
        console.log("=================");
        
        for await (const model of models) {
            console.log(`- ${model.name}`);
        }
        
    } catch (error: any) {
        console.error("❌ Failed to list models:", error.message);
    }
}

listModels();

