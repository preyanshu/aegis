import { GoogleGenAI } from "@google/genai";

// Load API key from environment
const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;

if (!apiKey) {
    console.error("❌ No API key found!");
    console.error("   Set GOOGLE_API_KEY or GEMINI_API_KEY environment variable");
    console.error("");
    console.error("   Example:");
    console.error("   GOOGLE_API_KEY=your_key_here npx tsx scripts/test-gemini-api.ts");
    process.exit(1);
}

console.log("🔑 API Key found:", apiKey.slice(0, 8) + "..." + apiKey.slice(-4));
console.log("🧪 Testing Gemini API connection...\n");

async function testApiKey() {
    try {
        const ai = new GoogleGenAI({ apiKey });

        // Try gemini-1.5-flash as it may have separate quota
        const model = process.env.GEMINI_MODEL || "gemini-1.5-flash";
        console.log("📦 Using model:", model);
        
        const response = await ai.models.generateContent({
            model: model,
            contents: "Say 'API key is valid!' and nothing else.",
        });

        const text = response.text;
        
        console.log("✅ API Response:", text);
        console.log("\n🎉 Your Gemini API key is VALID!");
        
    } catch (error: any) {
        console.error("❌ API Test Failed!\n");
        
        // Show full error details for debugging
        console.error("   Full Error Details:");
        console.error("   -------------------");
        console.error("   Status:", error.status || "N/A");
        console.error("   Message:", error.message || "N/A");
        console.error("   Error Code:", error.code || error.errorDetails?.[0]?.reason || "N/A");
        
        if (error.errorDetails) {
            console.error("   Error Details:", JSON.stringify(error.errorDetails, null, 2));
        }
        
        console.error("\n   Diagnosis:");
        if (error.message?.includes("API_KEY_INVALID") || error.status === 400) {
            console.error("   → Invalid API key");
            console.error("   → Get a valid key at: https://aistudio.google.com/apikey");
        } else if (error.message?.includes("PERMISSION_DENIED") || error.status === 403) {
            console.error("   → API key doesn't have permission for this model");
        } else if (error.message?.includes("QUOTA_EXCEEDED") || error.message?.includes("429") || error.status === 429) {
            console.error("   → Quota exceeded / Rate limited");
        } else if (error.message?.includes("RESOURCE_EXHAUSTED")) {
            console.error("   → Resource exhausted (quota/rate limit)");
        } else if (error.code === "ENOTFOUND" || error.code === "ECONNREFUSED") {
            console.error("   → Network error - check your internet connection");
        } else {
            console.error("   → Unknown error");
        }
        
        process.exit(1);
    }
}

testApiKey();

