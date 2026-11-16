export type AssessmentState = "ACCESSIBLE" | "INACCESSIBLE" | "INSUFFICIENT_LIGHTING";

export type Detection = {
  className: string;
  confidence: number;
  box: { x: number; y: number; width: number; height: number };
};

const HAZARD_CLASSES = new Set([
  "pothole",
  "distressed",
  "manhole",
  "grate",
  "spherical_roadblock",
  "stairs",
  "curb",
  "waste_container",
  "bicycle",
  "motorcycle",
  "car",
  "bus",
  "truck",
]);

const CONTEXT_CLASSES = new Set([
  "bench",
  "person",
  "dog",
  "pole",
  "fire_hydrant",
  "warning_column",
  "bus_stop",
  "tree",
]);

const ASSESSMENT_REGION = {
  left: 0.12,
  top: 0.18,
  right: 0.88,
  bottom: 0.9,
};

function isInsideRegion(det: Detection, width: number, height: number) {
  const centerX = det.box.x + det.box.width / 2;
  const centerY = det.box.y + det.box.height / 2;

  const withinHorizontal =
    centerX >= width * ASSESSMENT_REGION.left &&
    centerX <= width * ASSESSMENT_REGION.right;
  const withinVertical =
    centerY >= height * ASSESSMENT_REGION.top &&
    centerY <= height * ASSESSMENT_REGION.bottom;

  return withinHorizontal && withinVertical;
}

function getSeverity(det: Detection) {
  const className = det.className.toLowerCase();

  if (className === "pothole" || className === "manhole" || className === "grate") {
    return 3;
  }
  if (
    className === "stairs" ||
    className === "spherical_roadblock" ||
    className === "distressed"
  ) {
    return 2.5;
  }
  if (
    className === "curb" ||
    className === "waste_container" ||
    className === "bicycle" ||
    className === "motorcycle" ||
    className === "car" ||
    className === "bus" ||
    className === "truck"
  ) {
    return 2;
  }

  return 0;
}

export function assessDetections(
  detections: Detection[],
  width: number,
  height: number,
  lightingStatus: "SUFFICIENT LIGHTING" | "INSUFFICIENT LIGHTING",
) {
  if (lightingStatus !== "SUFFICIENT LIGHTING") {
    return {
      state: "INSUFFICIENT_LIGHTING" as const,
      summary: "Lighting is insufficient for an accessibility assessment.",
      details:
        "The sidewalk area is too dim to assess hazards reliably. This result is withheld until lighting improves.",
      flaggedDetections: [],
      confidence: 0,
    };
  }

  const inRegion = detections.filter((det) => isInsideRegion(det, width, height));
  const hazardDetections = inRegion.filter((det) => HAZARD_CLASSES.has(det.className));
  const contextDetections = inRegion.filter((det) => CONTEXT_CLASSES.has(det.className));

  const hazardScore = hazardDetections.reduce((total, det) => {
    const severity = getSeverity(det);
    const confidenceWeight = det.confidence > 0.6 ? 1 : det.confidence > 0.4 ? 0.75 : 0.5;
    return total + severity * confidenceWeight;
  }, 0);

  const contextualScore = contextDetections.reduce((total, det) => {
    return total + det.confidence * 0.5;
  }, 0);

  const strongestHazard = hazardDetections.reduce(
    (largest, det) => Math.max(largest, det.confidence),
    0,
  );

  if (hazardScore >= 3.5 || strongestHazard >= 0.68) {
    return {
      state: "INACCESSIBLE" as const,
      summary: "The sidewalk appears inaccessible from the current view.",
      details:
        "High-confidence hazards in the assessment region suggest a likely obstruction or unsafe walking condition.",
      flaggedDetections: hazardDetections,
      confidence: Math.min(0.95, hazardScore / 6 + strongestHazard / 2),
    };
  }

  if (hazardScore > 0.5 || contextualScore > 0.8) {
    return {
      state: "ACCESSIBLE" as const,
      summary: "No major accessibility obstruction is currently evident.",
      details:
        "Detected objects are mostly contextual and do not strongly indicate a blocked or unsafe walking path in the sidewalk assessment region.",
      flaggedDetections: hazardDetections.length ? hazardDetections : contextDetections,
      confidence: Math.min(0.8, 0.5 + hazardScore / 10 + contextualScore / 10),
    };
  }

  return {
    state: "ACCESSIBLE" as const,
    summary: "Accessible based on the current frame.",
    details:
      "No major hazards were detected in the assessment region. This is a frame-level estimate and not a guarantee of universal accessibility.",
    flaggedDetections: [],
    confidence: 0.55,
  };
}

export function buildAssessmentDisclaimer() {
  return "Camera-based assessment is a decision-support tool only. It cannot guarantee sidewalk accessibility, especially without testing the exact walking path, surface quality, curb cuts, and user mobility needs.";
}
