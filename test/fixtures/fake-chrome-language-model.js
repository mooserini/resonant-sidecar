/** In-memory Prompt API boundary. It opens no process, port, or browser.
 * A held prompt deliberately ignores abort until complete(): the real adapter
 * must discard late completion and destroy the session itself. */
export function createFakeLanguageModel({ absent = false, availability = 'available', availabilityFailure = false,
  createFailure = null, promptFailure = null, destroyFailure = false, holdPrompt = false, rawText } = {}) {
  const calls = [], sessions = [];
  let complete;
  const held = new Promise(resolve => { complete = resolve; });
  const failure = name => Object.assign(new Error('Synthetic model failure'), { name });
  const languageModel = absent ? undefined : {
    async availability(options) {
      calls.push({ method: 'availability', options });
      if (availabilityFailure) throw failure('NotSupportedError');
      return availability;
    },
    async create(options) {
      calls.push({ method: 'create', options });
      if (createFailure) throw failure(createFailure);
      const session = {
        destroyCalls: 0,
        async prompt(input, promptOptions) {
          calls.push({ method: 'prompt', input, options: promptOptions });
          if (promptFailure) throw failure(promptFailure);
          return holdPrompt ? held : rawText;
        },
        destroy() {
          session.destroyCalls++; calls.push({ method: 'destroy' });
          if (destroyFailure) throw failure('InvalidStateError');
        },
      };
      sessions.push(session);
      return session;
    },
  };
  return { languageModel, calls, sessions, complete };
}
