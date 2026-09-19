## Variant: Context Canvas

### Design stance
Treat the active page as shared conversational context while keeping the ongoing relationship with Hermes visually dominant.

### Key choices
- Layout: rich active-page card, conversational thread, and suggestion-led composer.
- Typography: warm contemporary product UI.
- Color: light/dark adaptive Resonant Mirror palette with tactile cream and copper surfaces.
- Interaction: page-specific quick actions, reusable prompt chips, and a two-dimensional authority picker.

### Authority model
- Page access: read-only, read/write once, or read/write for the Sidecar session.
- Approval policy: Minimal asks every time, Auto-accept delegates prompts to Hermes Sentinel, and Full YOLO runs uninterrupted inside the selected page-access boundary.
- The two controls stay separate because scope answers **what may happen**, while approval policy answers **when Tom must be interrupted**.

### Trade-offs
- Strong at: making “Sidecar follows the browser” immediately understandable and approachable.
- Weak at: dense multi-tool supervision and long execution traces; those belong in a secondary activity view.

### Best for
- A general-audience product where the core action is asking an agent to understand or help with the page in front of the human.
