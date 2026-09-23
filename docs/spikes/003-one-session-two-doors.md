# Spike 003 — One session, two doors (VALIDATED with fix, Sept 2026)

Question: given one Hermes session opened through the sidecar transport,
when the pipe is killed dead and a different connection resumes the same
session id, then history survives.

Method: door one opens a session, stores a secret word, gets SIGKILL. Door
two (fresh host process, standing in for Discord) reopens with the same id
and asks for the word.

Result: Hermes replayed the stored text through the new pipe — history
survived death — but the sidecar answered `error` instead of
`session.ready`. A raw probe (no sidecar) showed why: `session/resume`
succeeds across processes, but its reply carries models and payload with
**no `sessionId` field**, and `openSession` demanded one.

Fixes shipped on branch `fix/reconnect-honest-plumbing`: on resume the
requested id stands; replayed history chunks with no live turn are
swallowed. Re-run: `session.ready` with the SAME id, secret recalled
verbatim (`KESTREL-7`), no ghost cards.

Standing value: continuity lives in Hermes; doors are dumb. This is the
green light for the Discord door and the future session picker. No
list-recent-sessions primitive over ACP has been demonstrated yet — that
remains the open question for the picker.
