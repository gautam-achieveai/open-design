import { DEFAULT_MODEL_OPTION } from './shared.js';
import type { RuntimeAgentDef } from '../types.js';

// AtomCode — open-source terminal AI coding agent written in Rust.
// Repo:   https://atomgit.com/atomgit_atomcode/atomcode
// Docs:   https://atomcode.atomgit.com/docs/en/index.html
// Install: `cargo install --path crates/atomcode-cli --locked` (from source)
//          or `npm install -g @atomgit.com/atomcode` / `brew install --cask atomcode`
//
// Headless mode with `--prompt-file <PATH>` runs a single prompt
// non-interactively and streams the assistant reply on stdout. OD composes the
// prompt in a temp file to stay clear of argv length limits, exactly like
// grok-build.
//
// AtomCode owns its own authentication: users run `atomcode login` (AtomGit
// OAuth, auto-persisted under `~/.atomcode/`) or set up an API key in
// `~/.atomcode/config.toml` before OD detects the binary. The daemon does not
// inject credentials. Any OpenAI-compatible provider works (Anthropic, OpenAI,
// DeepSeek, Zhipu/GLM, Qwen, SiliconFlow, Ollama, …).
//
// Output: AtomCode headless has no structured stream-json mode yet — it emits
// plain-text assistant replies on stdout and verbose diagnostics (tool calls,
// token usage) on stderr with `-v`. We therefore use `streamFormat: 'plain'`
// (single-turn text reply, no tool_use streaming). Upgrading to a structured
// parser is follow-up work once AtomCode ships a stable JSON event stream.
//
// Safety: OD passes AtomCode's documented `-y` flag so the non-interactive run
// can proceed without waiting for an approval prompt it cannot surface.
export const atomcodeAgentDef = {
    id: 'atomcode',
    name: 'AtomCode CLI',
    bin: 'atomcode',
    versionArgs: ['--version'],
    // AtomCode is provider-agnostic; custom model entry remains available
    // without hardcoding provider catalog snapshots that quickly go stale.
    fallbackModels: [DEFAULT_MODEL_OPTION],
    // `--prompt-file <PATH>` avoids argv length limits for long OD prompts.
    // `-y` auto-approves tool calls in headless mode (no interactive TTY).
    // `--model <id>` selects the upstream provider/model when non-default.
    buildArgs: (
      _prompt,
      _imagePaths,
      _extraAllowedDirs = [],
      options = {},
      runtimeContext = {},
    ) => {
      if (!runtimeContext.promptFilePath) {
        throw new Error('atomcode requires runtimeContext.promptFilePath');
      }
      const args = [
        '--prompt-file',
        runtimeContext.promptFilePath,
        '-y',
      ];
      if (options.model && options.model !== DEFAULT_MODEL_OPTION.id) {
        args.push('--model', options.model);
      }
      return args;
    },
    promptViaFile: true,
    promptViaStdin: false,
    streamFormat: 'plain',
    installUrl: 'https://atomcode.atomgit.com/docs/en/quickstart.html',
    docsUrl: 'https://atomcode.atomgit.com/docs/en/index.html',
} satisfies RuntimeAgentDef;
