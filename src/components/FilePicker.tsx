// FilePicker — choose an audio file. If the current directory has audio files, show them in a
// keyboard-navigable <select>; otherwise fall back to a path <input>. Either way the chosen path
// is resolved to absolute and handed to onPick. (One focused control at a time — no dual-focus
// juggling; the input is the fallback for when cwd has nothing to list.)

import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { useMemo, useState } from "react";
import { C } from "./theme";

const AUDIO_EXT = [".mp3", ".wav", ".flac", ".aiff", ".aif", ".m4a", ".ogg"];

function listAudio(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => AUDIO_EXT.some((e) => f.toLowerCase().endsWith(e)))
      .sort();
  } catch {
    return [];
  }
}

export function FilePicker({
  onPick,
  focused,
}: {
  onPick: (absPath: string) => void;
  focused: boolean;
}) {
  const cwd = process.cwd();
  const files = useMemo(() => listAudio(cwd), [cwd]);
  const [path, setPath] = useState("");

  return (
    <box
      flexDirection="column"
      border
      borderStyle="single"
      borderColor={focused ? C.borderFocus : C.border}
      paddingX={1}
      title="OPEN AN AUDIO FILE"
      flexGrow={1}
    >
      {files.length > 0 ? (
        <box flexDirection="column">
          <text fg={C.dim}>audio files in {cwd}</text>
          <select
            focused={focused}
            options={files.map((f) => ({ name: f, description: "", value: resolve(cwd, f) }))}
            onSelect={(_index, option) => {
              if (option) onPick(String(option.value));
            }}
          />
        </box>
      ) : (
        <box flexDirection="column">
          <text fg={C.dim}>no audio files in {cwd} — type a path:</text>
          <input
            focused={focused}
            value={path}
            onInput={setPath}
            onSubmit={() => {
              // Use the controlled value (onInput keeps it current); the submit payload is a
              // string | SubmitEvent union we don't need here.
              const t = path.trim();
              if (t) onPick(resolve(cwd, t));
            }}
            placeholder="/path/to/song.mp3"
          />
        </box>
      )}
    </box>
  );
}
