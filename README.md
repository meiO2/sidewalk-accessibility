# Sidewalk Accessibility Detection

A mobile-friendly Next.js dashboard for real-time camera-based sidewalk hazard detection and accessibility assessment. The app uses a trained YOLO model at `models/best.pt` and evaluates a lighting gate plus a transparent rule-based accessibility check before reporting an assessment.

## Features

- Live camera preview with browser permission handling
- Rear-camera preference for mobile browsers
- Nearby real-time detection loop with rate limiting
- Bounding boxes and confidence labels over the live preview
- Adjustable detection confidence threshold (starts at 25%)
- Lighting validation before assessment is allowed
- Rule-based accessibility assessment for hazard classes and sidewalk region risk
- Clear limitations for camera-based assessment

## Local setup

1. Install frontend dependencies:

```bash
npm install
```

2. Install the Python inference dependencies:

```bash
python -m pip install -r requirements.txt
```

3. Copy the environment template if needed:

```bash
copy .env.example .env.local
```

4. Start the inference backend:

```bash
python server.py
```

For a deployed frontend, host the FastAPI inference service separately and set `INFERENCE_API_URL` in the Vercel project to its full `/api/infer` URL (for example, `https://your-backend.example.com/api/infer`). The Next.js `/api/infer` route proxies frames to that service, so browser CORS configuration is not needed for this path. If calling the Python service directly from the browser using `NEXT_PUBLIC_INFERENCE_URL`, configure `FRONTEND_ORIGINS` on the Python service with the Vercel origin.

5. Start the Next.js app:

```bash
npm run dev
```

Then open http://localhost:3000.

## Model requirements

The app loads the existing YOLO checkpoint at `models/best.pt`. The model is verified at runtime by reading `model.names` instead of hardcoding a replacement class map.

The detected class names are:

1. bench
2. bicycle
3. bus
4. bus_stop
5. cane
6. car
7. curb
8. dog
9. fire_hydrant
10. motorcycle
11. person
12. pole
13. spherical_roadblock
14. stairs
15. stop_sign
16. street_light
17. traffic_light
18. train
19. tree
20. truck
21. warning_column
22. waste_container
23. pothole
24. distressed
25. manhole
26. grate

## Deployment note for Vercel

The Next.js deployment does not expose `api/infer.py` as a Python function: the Next.js framework handles requests for the project. The Next.js route at `/api/infer` therefore proxies to a separately deployed FastAPI service. Set `INFERENCE_API_URL` in Vercel to the complete backend inference URL and redeploy; without it, the route returns a visible `503` configuration error instead of silently appearing to return no detections.

Run the Python service on a host that supports the project's model dependencies, such as Render, Railway, Fly.io, or a containerized Cloud Run/VM deployment. Verify that `https://your-backend.example.com/health` reports `status: "ok"` and the model's class names before setting the Vercel environment variable.

## Running the backend manually

The next functions are available for local evaluation:

```bash
python server.py
```

And the inference endpoint is served on:

- http://localhost:8000/health
- http://localhost:8000/api/infer

## Limitations

- Camera-based results are frame-level estimates, not certified sidewalk accessibility audits.
- Local daylight imaging and a stable sidewalk region are assumed.
- The model can detect hazards but cannot confirm curb cuts, grading, drainage, or user-specific mobility constraints.
- An assessment result should be treated as a decision-support tool rather than a legal or engineering guarantee.
