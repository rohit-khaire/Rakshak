How to Explain This Flowchart in Your Presentation (Slide Script)
When presenting, you can explain the entire system in 5 crisp, logical steps:

Top (Phases 1 & 2) — Ingestion & AI Pre-flight:

"We start with two pathways: distressed families can file an instant Emergency Pre-FIR report under Section 217 of BNS 2023, while police officers can upload physical paper FIRs that are automatically digitized in the browser via Tesseract.js OCR. Before hitting our database, our client-side AI inspects photo quality (blur, lighting, face bounding box) and our backend duplicate engine prevents double-filing using Levenshtein distance and geospatial heuristics."

Middle-Left (Phases 3 & 4) — Triage & Geospatial Routing:

"In Phase 3, our rule-based triage automatically assigns a priority level (Critical, High, Medium, Low) based on vulnerability factors like age and time elapsed. The incident is mapped directly to the nearest station via MongoDB 2dsphere indexing, ensuring no report floats unassigned."

Center (Phase 5) — Zero-Trust Biometrics:

"In Phase 5, before any official action occurs (such as registering an official FIR or verifying a sighting), our system enforces a Biometric Step-Up Gate. A single-use cryptographic challenge nonce is issued. The officer's webcam captures Eye Aspect Ratio (EAR) blink liveness or head-turn yaw geometry. The server recomputes the math from raw landmarks and verifies the 128-dimensional embedding against DySP-enrolled reference vectors. The moment the action completes, the nonce is deleted, permanently preventing replay attacks. If someone tries to guess 3 times, the officer's account is automatically locked."

Right (Phases 6 & 7) — Sighting Verification & Cross-Border Intelligence:

"Once verified, nearby NGOs are auto-linked within their operational service radius. If a citizen spots the missing person in another city (e.g. a Pune child spotted in Bandra, Mumbai), our geospatial engine triggers a Cross-Jurisdiction Alert via WebSockets—notifying both the Pune station and the Bandra station simultaneously."

Bottom (Phase 8) — Resolution & Governance:

"In the final phase, verified sightings transition the case to under_search. When resolved, cases are marked found, while unresolved closures are strictly restricted to District Control (DySP) and above. Every mutation is immutably recorded in AuditLog and scoped dynamically across our 9-role hierarchy."

11:26 PM
