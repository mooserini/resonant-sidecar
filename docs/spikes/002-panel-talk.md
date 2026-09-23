# Spike 002 — Real panel talk (SUPERSEDED by live runs, Sept 2026)

Question (as framed): given Chrome Dev with the registered origin, when the
side panel opens and sends text, then Hermes replies and the thread resumes
after close/reopen.

What actually happened: the scripted spike was never run. The human ran it
live instead — nonce echo, "Steve Irwin", then the reconnect failure that
produced the honest-status fix, the auto-reconnect fix, and spike 003.

Live results replaced the spike: first turn works through the real pipe;
close/reopen exposed a stuck `Connecting` status (fixed), a document that
outlives its pipe with no redial path (fixed), and a resume handshake that
rejected valid reunions (fixed, see 003).

Finding recorded so the next failure of this shape is a reconnect bug until
proven otherwise, not a transport question.
