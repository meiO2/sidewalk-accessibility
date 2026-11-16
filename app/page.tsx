"use client";

import { useEffect, useRef, useState } from "react";
import { assessDetections, buildAssessmentDisclaimer, type Detection } from "@/lib/assessment";

const DEFAULT_INFERENCE_URL = "/api/infer";
const CLASS_COLORS: Record<string, string> = {
  pothole: "#ef4444",
  distressed: "#f97316",
  manhole: "#f97316",
  grate: "#f59e0b",
  spherical_roadblock: "#ef4444",
  stairs: "#a855f7",
  curb: "#fb7185",
  waste_container: "#e11d48",
  bicycle: "#22c55e",
  motorcycle: "#22c55e",
  car: "#f43f5e",
  bus: "#f43f5e",
  truck: "#f43f5e",
  bench: "#38bdf8",
  person: "#22c55e",
  dog: "#a3e635",
  pole: "#60a5fa",
  fire_hydrant: "#fbbf24",
  warning_column: "#f59e0b",
  bus_stop: "#2dd4bf",
  tree: "#34d399",
  default: "#38bdf8",
};

function getClassColor(label: string) {
  return CLASS_COLORS[label] ?? CLASS_COLORS.default;
}

function formatConfidence(value: number) {
  return `${Math.round(value * 100)}%`;
}

export default function Home() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const loopRef = useRef<number | null>(null);
  const requestInFlight = useRef(false);
  const runningRef = useRef(false);
  const confidenceThresholdRef = useRef(0.25);

  const [cameraStatus, setCameraStatus] = useState("Idle");
  const [applicationStatus, setApplicationStatus] = useState("Standby");
  const [cameraError, setCameraError] = useState("");
  const [isCameraReady, setIsCameraReady] = useState(false);
  const [videoDimensions, setVideoDimensions] = useState({ width: 1280, height: 720 });
  const [isDetectionRunning, setIsDetectionRunning] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [confidenceThreshold, setConfidenceThreshold] = useState(0.25);
  const [lightingStatus, setLightingStatus] = useState<"SUFFICIENT LIGHTING" | "INSUFFICIENT LIGHTING">(
    "SUFFICIENT LIGHTING",
  );
  const [detectedObjects, setDetectedObjects] = useState<Detection[]>([]);
  const [assessmentResult, setAssessmentResult] = useState<{
    state: "ACCESSIBLE" | "INACCESSIBLE" | "INSUFFICIENT_LIGHTING" | "UNAVAILABLE";
    summary: string;
    details: string;
    confidence: number;
  }>({
    state: "ACCESSIBLE",
    summary: "Awaiting a fresh frame.",
    details: "Start the camera and detection loop to begin assessment.",
    confidence: 0,
  });

  const inferenceUrl =
    process.env.NEXT_PUBLIC_INFERENCE_URL || DEFAULT_INFERENCE_URL;

  useEffect(() => {
    const updateVideoDimensions = () => {
      const video = videoRef.current;
      if (!video) {
        return;
      }

      setVideoDimensions({
        width: video.videoWidth || 1280,
        height: video.videoHeight || 720,
      });
    };

    const video = videoRef.current;
    if (video) {
      video.addEventListener("loadedmetadata", updateVideoDimensions);
      video.addEventListener("resize", updateVideoDimensions);
      updateVideoDimensions();
    }

    return () => {
      if (video) {
        video.removeEventListener("loadedmetadata", updateVideoDimensions);
        video.removeEventListener("resize", updateVideoDimensions);
      }
      if (loopRef.current) {
        window.clearTimeout(loopRef.current);
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  async function requestCameraAccess() {
    if (streamRef.current && videoRef.current) {
      setCameraStatus("Live");
      setIsCameraReady(true);
      return true;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraStatus("Unsupported");
      setCameraError("This browser does not support camera access.");
      return false;
    }

    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });

      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) {
        throw new Error("Camera preview element is unavailable.");
      }
      video.srcObject = stream;
      await video.play();

      setCameraStatus("Live");
      setCameraError("");
      setIsCameraReady(true);
      setApplicationStatus("Camera ready");
      return true;
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      if (videoRef.current?.srcObject === stream) {
        videoRef.current.srcObject = null;
      }
      streamRef.current = null;
      const message = error instanceof Error ? error.message : "Unknown camera access error";
      setCameraStatus("Denied");
      setCameraError(`Camera permission denied or unavailable: ${message}`);
      setApplicationStatus("Waiting for camera permission");
      return false;
    }
  }

  function stopCamera() {
    runningRef.current = false;
    setIsDetectionRunning(false);
    if (loopRef.current) {
      window.clearTimeout(loopRef.current);
      loopRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setIsCameraReady(false);
    setCameraStatus("Stopped");
    setApplicationStatus("Camera stopped");
  }

  function computeLightingStatus(video: HTMLVideoElement): "SUFFICIENT LIGHTING" | "INSUFFICIENT LIGHTING" {
    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;
    const x = Math.floor(width * 0.2);
    const y = Math.floor(height * 0.25);
    const w = Math.floor(width * 0.6);
    const h = Math.floor(height * 0.5);

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const context = canvas.getContext("2d");

    if (!context) {
      return "SUFFICIENT LIGHTING";
    }

    context.drawImage(video, x, y, w, h, 0, 0, w, h);
    const imageData = context.getImageData(0, 0, w, h).data;
    let total = 0;

    for (let i = 0; i < imageData.length; i += 4) {
      total += (imageData[i] + imageData[i + 1] + imageData[i + 2]) / 3;
    }

    const averageBrightness = total / (imageData.length / 4);
    return averageBrightness >= 70 ? "SUFFICIENT LIGHTING" : "INSUFFICIENT LIGHTING";
  }

  async function runInferenceFrame() {
    const video = videoRef.current;
    if (!video || !isCameraReady || requestInFlight.current) {
      return;
    }

    requestInFlight.current = true;
    setIsProcessing(true);

    try {
      const width = video.videoWidth || 1280;
      const height = video.videoHeight || 720;
      const nextLighting = computeLightingStatus(video);
      setLightingStatus(nextLighting);

      if (nextLighting === "INSUFFICIENT LIGHTING") {
        setAssessmentResult({
          state: "INSUFFICIENT_LIGHTING",
          summary: "Insufficient lighting to assess the sidewalk safely.",
          details: "The scene is too dim for a reliable accessibility assessment. Wait for better daylight or increase illumination.",
          confidence: 0,
        });
        setDetectedObjects([]);
        return;
      }

      const canvas = document.createElement("canvas");
      const targetWidth = Math.min(width, 1280);
      const targetHeight = Math.round((height / width) * targetWidth);
      canvas.width = targetWidth;
      canvas.height = targetHeight;

      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("Canvas context not available.");
      }

      context.drawImage(video, 0, 0, targetWidth, targetHeight);
      const imageData = canvas.toDataURL("image/jpeg", 0.8);

      const response = await fetch(inferenceUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image: imageData,
          conf_threshold: confidenceThresholdRef.current,
        }),
      });

      const payload = await response.json();

      if (!response.ok || payload.error) {
        throw new Error(payload.detail || payload.error || "Inference request failed.");
      }

      type DetectionResponse = {
        class_name?: string;
        confidence?: number;
        box?: {
          x?: number;
          y?: number;
          width?: number;
          height?: number;
        };
      };

      const detections = Array.isArray(payload.detections)
        ? payload.detections.map((item: DetectionResponse) => ({
            className: String(item.class_name ?? "unknown"),
            confidence: Number(item.confidence ?? 0),
            box: {
              x: Number(item.box?.x ?? 0),
              y: Number(item.box?.y ?? 0),
              width: Number(item.box?.width ?? 0),
              height: Number(item.box?.height ?? 0),
            },
          }))
        : [];

      setDetectedObjects(detections);
      const evaluated = assessDetections(detections, targetWidth, targetHeight, nextLighting);
      setAssessmentResult(evaluated);
      setApplicationStatus(
        evaluated.state === "INACCESSIBLE"
          ? "Potential obstruction detected"
          : evaluated.state === "INSUFFICIENT_LIGHTING"
            ? "Lighting check required"
            : "Monitoring sidewalk safety",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown detection error";
      setAssessmentResult({
        state: "UNAVAILABLE",
        summary: "Detection request failed.",
        details: `The model could not process the current frame. ${message}`,
        confidence: 0,
      });
      setApplicationStatus("Inference error");
    } finally {
      requestInFlight.current = false;
      setIsProcessing(false);
    }
  }

  async function startDetectionLoop() {
    if (!isCameraReady) {
      const cameraStarted = await requestCameraAccess();
      if (!cameraStarted) {
        return;
      }
    }

    runningRef.current = true;
    setIsDetectionRunning(true);
    setApplicationStatus("Monitoring sidewalk safety");

    const loop = async () => {
      if (!runningRef.current) {
        return;
      }

      if (!requestInFlight.current) {
        await runInferenceFrame();
      }

      if (runningRef.current) {
        loopRef.current = window.setTimeout(loop, 700);
      }
    };

    loopRef.current = window.setTimeout(loop, 250);
  }

  function stopDetectionLoop() {
    runningRef.current = false;
    setIsDetectionRunning(false);
    setApplicationStatus("Camera ready");
    setDetectedObjects([]);
    if (loopRef.current) {
      window.clearTimeout(loopRef.current);
      loopRef.current = null;
    }
  }

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-6 text-slate-100 md:px-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="rounded-3xl border border-slate-800 bg-slate-900/80 p-4 shadow-2xl shadow-cyan-950/20 backdrop-blur md:p-5">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.28em] text-cyan-400">Project dashboard</p>
              <h1 className="mt-2 text-2xl font-bold tracking-tight text-white md:text-3xl">
                Sidewalk Accessibility Detection
              </h1>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <div className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-sm font-medium text-emerald-300">
                App status: {applicationStatus}
              </div>
              <div className="rounded-full border border-sky-500/40 bg-sky-500/10 px-3 py-1 text-sm font-medium text-sky-300">
                Camera status: {cameraStatus}
              </div>
            </div>
          </div>
        </header>

        <section className="grid gap-6 xl:grid-cols-[2.1fr_0.9fr]">
          <div className="rounded-3xl border border-slate-800 bg-slate-900/75 p-4 shadow-xl shadow-slate-950/40">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-white">Live camera</h2>
                <p className="text-sm text-slate-300">Rear camera preference on mobile, with graceful fallback if unavailable.</p>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => requestCameraAccess()}
                  className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-4 py-2 text-sm font-semibold text-cyan-200 transition hover:bg-cyan-500/20"
                >
                  Start Camera
                </button>
                <button
                  type="button"
                  onClick={stopCamera}
                  className="rounded-full border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-700"
                >
                  Stop Camera
                </button>
                <button
                  type="button"
                  onClick={startDetectionLoop}
                  disabled={!isCameraReady}
                  className="rounded-full bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
                >
                  {isDetectionRunning ? "Detection Active" : "Start Detection"}
                </button>
                <button
                  type="button"
                  onClick={stopDetectionLoop}
                  className="rounded-full border border-rose-500/40 bg-rose-500/10 px-4 py-2 text-sm font-semibold text-rose-200 transition hover:bg-rose-500/20"
                >
                  Stop Detection
                </button>
              </div>
            </div>

            <label className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-slate-700 bg-slate-950/60 px-4 py-3 text-sm text-slate-200">
              <span className="font-medium">Confidence threshold</span>
              <input
                type="range"
                min="0.05"
                max="0.75"
                step="0.05"
                value={confidenceThreshold}
                onChange={(event) => {
                  const nextThreshold = Number(event.target.value);
                  confidenceThresholdRef.current = nextThreshold;
                  setConfidenceThreshold(nextThreshold);
                }}
                className="min-w-32 flex-1 accent-cyan-400"
                aria-label="Detection confidence threshold"
              />
              <span className="w-12 text-right font-semibold text-cyan-300">
                {Math.round(confidenceThreshold * 100)}%
              </span>
              <span className="basis-full text-xs text-slate-400">
                Lower thresholds can reveal weaker detections, but may increase false positives.
              </span>
            </label>

            <div className="relative overflow-hidden rounded-2xl border border-slate-700 bg-slate-950 shadow-inner">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className={`h-[520px] w-full object-cover ${!isCameraReady ? "hidden" : "block"}`}
              />

              {!isCameraReady && (
                <div className="flex h-[520px] items-center justify-center bg-[radial-gradient(circle,_rgba(14,116,144,0.2),_rgba(2,6,23,0.9))] p-8 text-center">
                  <div>
                    <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full border border-cyan-500/30 bg-cyan-500/10 text-2xl text-cyan-300">
                      📷
                    </div>
                    <p className="text-base font-semibold text-slate-100">Camera preview is offline</p>
                    <p className="mt-2 max-w-md text-sm text-slate-300">
                      Grant camera access on a phone or desktop browser to begin live detection.
                    </p>
                  </div>
                </div>
              )}

              {isCameraReady && (
                <div className="pointer-events-none absolute inset-0">
                  {detectedObjects.map((box, index) => {
                    const left = (box.box.x / videoDimensions.width) * 100;
                    const top = (box.box.y / videoDimensions.height) * 100;
                    const width = (box.box.width / videoDimensions.width) * 100;
                    const height = (box.box.height / videoDimensions.height) * 100;

                    return (
                      <div
                        key={`${box.className}-${index}`}
                        className="absolute rounded-md border-2 bg-transparent"
                        style={{
                          left: `${left}%`,
                          top: `${top}%`,
                          width: `${Math.max(4, width)}%`,
                          height: `${Math.max(4, height)}%`,
                          borderColor: getClassColor(box.className),
                          boxShadow: `0 0 0 1px ${getClassColor(box.className)}66`,
                        }}
                      >
                        <div
                          className="absolute -top-7 left-0 rounded-full border px-2 py-1 text-[10px] font-semibold leading-none text-white"
                          style={{
                            backgroundColor: `${getClassColor(box.className)}cc`,
                            borderColor: getClassColor(box.className),
                          }}
                        >
                          {box.className} {formatConfidence(box.confidence)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {isProcessing && (
                <div className="absolute inset-x-0 bottom-4 flex justify-center">
                  <div className="rounded-full border border-cyan-500/40 bg-slate-950/80 px-4 py-2 text-sm font-medium text-cyan-200">
                    Analyzing frame…
                  </div>
                </div>
              )}
            </div>

            {cameraError && (
              <p className="mt-3 rounded-2xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                {cameraError}
              </p>
            )}
          </div>

          <aside className="space-y-4">
            <div className="rounded-3xl border border-slate-800 bg-slate-900/75 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400">Assessment</p>
              <div className="mt-4 rounded-2xl border border-slate-700 bg-slate-950/80 p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <span className="text-sm uppercase tracking-[0.2em] text-slate-400">Overall state</span>
                  <span
                    className={`rounded-full border px-2.5 py-1 text-xs font-bold uppercase tracking-[0.16em] ${
                      assessmentResult.state === "INACCESSIBLE"
                        ? "border-rose-500/40 bg-rose-500/10 text-rose-300"
                        : assessmentResult.state === "INSUFFICIENT_LIGHTING"
                          ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                          : assessmentResult.state === "UNAVAILABLE"
                            ? "border-slate-500/40 bg-slate-500/10 text-slate-300"
                            : "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                    }`}
                  >
                    {assessmentResult.state}
                  </span>
                </div>

                <p className="text-xl font-bold text-white">{assessmentResult.summary}</p>
                <p className="mt-2 text-sm leading-relaxed text-slate-300">{assessmentResult.details}</p>
                <p className="mt-3 text-xs uppercase tracking-[0.18em] text-slate-400">
                  Confidence estimate: {Math.round(assessmentResult.confidence * 100)}%
                </p>
              </div>
            </div>

            <div className="rounded-3xl border border-slate-800 bg-slate-900/75 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400">Lighting validation</p>
              <div className="mt-4 rounded-2xl border border-slate-700 bg-slate-950/80 p-4">
                <p className="text-sm font-medium text-slate-200">Current lighting</p>
                <p className="mt-2 text-lg font-bold text-white">{lightingStatus}</p>
                <p className="mt-2 text-sm text-slate-300">
                  {lightingStatus === "SUFFICIENT LIGHTING"
                    ? "The sidewalk region is appropriately lit for assessment."
                    : "The camera is too dark for a safe accessibility classification."}
                </p>
              </div>
            </div>

            <div className="rounded-3xl border border-slate-800 bg-slate-900/75 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400">Detected objects</p>
              <div className="mt-4 space-y-2">
                {detectedObjects.length === 0 ? (
                  <p className="rounded-2xl border border-dashed border-slate-700 bg-slate-950/60 p-3 text-sm text-slate-400">
                    No detections yet. Start the loop to see live objects.
                  </p>
                ) : (
                  detectedObjects.slice(0, 8).map((item, index) => (
                    <div key={`${item.className}-${index}`} className="flex items-center justify-between rounded-2xl border border-slate-700 bg-slate-950/60 px-3 py-2">
                      <div className="flex items-center gap-3">
                        <span
                          className="inline-block h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: getClassColor(item.className) }}
                        />
                        <span className="text-sm font-medium text-slate-100">{item.className}</span>
                      </div>
                      <span className="text-xs uppercase tracking-[0.16em] text-slate-300">
                        {formatConfidence(item.confidence)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </aside>
        </section>

        <section className="grid gap-6 lg:grid-cols-3">
          <div className="rounded-3xl border border-slate-800 bg-slate-900/75 p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.26em] text-slate-400">Safety logic</p>
            <p className="mt-4 text-base leading-7 text-slate-200">
              Potential hazards include potholes, distressed surfaces, manholes, grated areas, large obstacles, and blocked walking paths.
            </p>
          </div>

          <div className="rounded-3xl border border-slate-800 bg-slate-900/75 p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.26em] text-slate-400">Context rules</p>
            <p className="mt-4 text-base leading-7 text-slate-200">
              Benches, people, poles, trees, and vehicles are contextual; they are not automatically classified as inaccessible unless they obstruct the walking corridor.
            </p>
          </div>

          <div className="rounded-3xl border border-slate-800 bg-slate-900/75 p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.26em] text-slate-400">Limitation note</p>
            <p className="mt-4 text-base leading-7 text-slate-200">{buildAssessmentDisclaimer()}</p>
          </div>
        </section>
      </div>
    </main>
  );
}
