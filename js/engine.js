// MediaPipe FaceLandmarker with 52 ARKit blendshapes — CPU, VIDEO mode.
import { FilesetResolver, FaceLandmarker } from "../vendor/vision_bundle.mjs";

let face = null;

export async function initEngine() {
  const fileset = await FilesetResolver.forVisionTasks("vendor/wasm");
  face = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: "vendor/face_landmarker.task", delegate: "CPU" },
    runningMode: "VIDEO",
    numFaces: 1,
    outputFaceBlendshapes: true,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  return true;
}

export function engineReady() { return !!face; }

export function detectFace(video, ts) {
  if (!face) return { blend: null, lm: null, ms: 0 };
  const t0 = performance.now();
  const res = face.detectForVideo(video, ts);
  const ms = performance.now() - t0;
  let blend = null;
  if (res.faceBlendshapes && res.faceBlendshapes[0]) {
    blend = {};
    for (const c of res.faceBlendshapes[0].categories) blend[c.categoryName] = c.score;
  }
  const lm = res.faceLandmarks && res.faceLandmarks[0] ? res.faceLandmarks[0] : null;
  return { blend, lm, ms };
}