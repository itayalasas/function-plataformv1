import { useEffect, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import "monaco-editor/esm/vs/basic-languages/java/java.contribution.js";
import "monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js";
import "monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution.js";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution.js";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js";
import "monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution.js";
import "monaco-editor/esm/vs/basic-languages/html/html.contribution.js";
import "monaco-editor/esm/vs/basic-languages/css/css.contribution.js";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js";
import "monaco-editor/esm/vs/language/json/monaco.contribution.js";

interface Props {
  value: string;
  onChange: (v: string) => void;
  language?: string;
  path?: string;
}

export function MonacoCodeEditor({ value, onChange, language = "plaintext", path }: Props) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const detected = (() => {
    const lower = (path ?? "").toLowerCase();
    const fileName = lower.split("/").pop() ?? lower;
    if (!lower) return language;
    if (fileName === "dockerfile") return "dockerfile";
    if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
    if (
      lower.endsWith(".js") ||
      lower.endsWith(".jsx") ||
      lower.endsWith(".mjs") ||
      lower.endsWith(".cjs")
    )
      return "javascript";
    if (lower.endsWith(".json")) return "json";
    if (lower.endsWith(".md") || lower.endsWith(".mdx")) return "markdown";
    if (lower.endsWith(".css") || lower.endsWith(".scss") || lower.endsWith(".less")) return "css";
    if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
    if (
      lower.endsWith(".xml") ||
      fileName === "pom.xml" ||
      lower.endsWith(".csproj") ||
      lower.endsWith(".props") ||
      lower.endsWith(".targets")
    )
      return "xml";
    if (lower.endsWith(".java")) return "java";
    if (lower.endsWith(".cs")) return "csharp";
    if (lower.endsWith(".py")) return "python";
    if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
    return language;
  })();
  const diagnosticsEnabled = detected === "typescript" || detected === "javascript";

  const handleMount: OnMount = (_editor, monaco) => {
    monaco.editor.defineTheme("vortex-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": "#0a0a0a",
        "editor.foreground": "#e6e6e6",
        "editorLineNumber.foreground": "#444",
        "editorLineNumber.activeForeground": "#aaa",
        "editor.selectionBackground": "#264f78",
        "editorCursor.foreground": "#22d3ee",
        "editor.lineHighlightBackground": "#1a1a1a",
      },
    });
    monaco.editor.setTheme("vortex-dark");
    const disableSpellcheck = () => {
      const textarea = _editor.getDomNode()?.querySelector("textarea");
      if (!textarea) return;
      textarea.setAttribute("spellcheck", "false");
      textarea.setAttribute("autocapitalize", "off");
      textarea.setAttribute("autocomplete", "off");
      textarea.setAttribute("autocorrect", "off");
      textarea.setAttribute("aria-autocomplete", "none");
    };
    disableSpellcheck();
    window.setTimeout(disableSpellcheck, 0);

    monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
      target: monaco.languages.typescript.ScriptTarget.ESNext,
      module: monaco.languages.typescript.ModuleKind.ESNext,
      allowNonTsExtensions: true,
      noEmit: true,
      esModuleInterop: true,
      jsx: monaco.languages.typescript.JsxEmit.React,
      strict: false,
      moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    });
    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: false,
    });
  };

  if (!mounted) {
    return (
      <div className="h-full w-full bg-editor flex items-center justify-center text-xs text-muted-foreground font-mono">
        Cargando editor…
      </div>
    );
  }

  return (
    <Editor
      height="100%"
      width="100%"
      language={detected}
      value={value}
      onChange={(v) => onChange(v ?? "")}
      onMount={handleMount}
      theme="vortex-dark"
      options={{
        renderValidationDecorations: diagnosticsEnabled ? "on" : "off",
        fontSize: 13,
        fontFamily:
          'JetBrains Mono, ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
        fontLigatures: true,
        minimap: { enabled: true, scale: 0.75 },
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        cursorBlinking: "smooth",
        cursorSmoothCaretAnimation: "on",
        renderLineHighlight: "all",
        lineNumbers: "on",
        roundedSelection: false,
        automaticLayout: true,
        tabSize: 2,
        wordWrap: "off",
        bracketPairColorization: { enabled: true },
        guides: { bracketPairs: true, indentation: true },
        formatOnPaste: true,
        formatOnType: true,
        suggestOnTriggerCharacters: true,
        quickSuggestions: { other: true, comments: false, strings: true },
        padding: { top: 12, bottom: 12 },
      }}
    />
  );
}

export default MonacoCodeEditor;
