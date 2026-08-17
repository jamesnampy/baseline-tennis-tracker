import { NextResponse } from "next/server";

const SYSTEM_INSTRUCTIONS = `You are a cautious junior-tennis strategy analyst. Analyze only the supplied match dataset for both players.
Return concise, practical strategy for the user's player. Separate observed evidence from inference, name material data limitations, avoid psychological or medical diagnosis, and remind the user to follow tournament coaching rules. Never invent unobserved shots or scores.`;

function outputText(payload: { output?: Array<{ content?: Array<{ type?: string; text?: string }> }> }) {
  return payload.output?.flatMap((item) => item.content ?? []).filter((item) => item.type === "output_text").map((item) => item.text ?? "").join("\n").trim() ?? "";
}

export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "Strategy model is not configured." }, { status: 503 });
  const body = await request.json() as { question?: string; dataset?: unknown };
  const serialized = JSON.stringify(body.dataset ?? {});
  if (serialized.length > 120_000) return NextResponse.json({ error: "Dataset is too large." }, { status: 413 });

  const model = process.env.OPENAI_STRATEGY_MODEL ?? "gpt-5.6-luna";
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      store: false,
      reasoning: { effort: "low" },
      instructions: SYSTEM_INSTRUCTIONS,
      input: `${body.question ?? "Given the collected dataset for both players, what is the recommended strategy for my player?"}\n\nMATCH DATASET\n${serialized}`,
    }),
  });
  if (!response.ok) return NextResponse.json({ error: "The strategy service is temporarily unavailable." }, { status: 502 });
  const payload = await response.json() as { output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
  const text = outputText(payload);
  if (!text) return NextResponse.json({ error: "The strategy service returned no review." }, { status: 502 });
  return NextResponse.json({ response: text, provider: "openai", model });
}
