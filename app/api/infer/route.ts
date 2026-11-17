import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const inferenceApiUrl = process.env.INFERENCE_API_URL;
  if (!inferenceApiUrl) {
    return NextResponse.json(
      {
        detail:
          "Inference backend is not configured. Set INFERENCE_API_URL to the deployed FastAPI /api/infer endpoint.",
      },
      { status: 503 },
    );
  }

  try {
    const response = await fetch(inferenceApiUrl, {
      method: "POST",
      headers: { "Content-Type": request.headers.get("Content-Type") ?? "application/json" },
      body: await request.arrayBuffer(),
      cache: "no-store",
    });
    const contentType = response.headers.get("Content-Type") ?? "";
    const responseBody = await response.text();

    if (!contentType.includes("application/json")) {
      console.error(`Inference backend returned non-JSON content (status ${response.status}).`);
      return NextResponse.json(
        { detail: `Inference backend returned an unexpected response (status ${response.status}).` },
        { status: 502 },
      );
    }

    return new Response(responseBody, {
      status: response.status,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Could not reach the inference backend.", error);
    return NextResponse.json(
      { detail: "Could not reach the inference backend. Check INFERENCE_API_URL and the backend deployment." },
      { status: 502 },
    );
  }
}
