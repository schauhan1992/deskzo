"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Label, Textarea } from "@/components/ui/input";
import { COMMENT_MAX, NOTE_FOR, NOTE_MIN, STATUS_LABELS, type TaskStatusKey } from "@/lib/tasks/rules";

type Asking = { taskId: string; status: TaskStatusKey; title: string };

/**
 * Moving a task, asking first for the note Need help and Cancelled need (owner, 22 Oct 2026; src/lib/tasks/rules.ts,
 * NOTE_FOR) — the same question wherever a status is picked: the record pages' task lists, the board, the task's
 * panel. `send` does the move; the server checks the note again and keeps it as a comment on the task.
 */
export function useStatusMove(send: (taskId: string, status: TaskStatusKey, note?: string) => void) {
  const [asking, setAsking] = useState<Asking | null>(null);
  const move = (taskId: string, status: TaskStatusKey, title: string) => {
    if (NOTE_FOR[status]) setAsking({ taskId, status, title });
    else send(taskId, status);
  };
  const dialog = asking ? (
    <StatusNoteDialog
      status={asking.status}
      taskTitle={asking.title}
      onCancel={() => setAsking(null)}
      onConfirm={(note) => {
        setAsking(null);
        send(asking.taskId, asking.status, note);
      }}
    />
  ) : null;
  return { move, dialog };
}

/** The note itself: why it's cancelled, or what help is needed — required, at least a few words. */
export function StatusNoteDialog({ status, taskTitle, onCancel, onConfirm }: { status: TaskStatusKey; taskTitle: string; onCancel: () => void; onConfirm: (note: string) => void }) {
  const need = NOTE_FOR[status];
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  // The dialog puts focus on its first control, the close button; the box is where the note is typed.
  useEffect(() => {
    const frame = requestAnimationFrame(() => box.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  function confirm() {
    if (note.trim().length < NOTE_MIN) {
      setError(need?.missing ?? "Add a note.");
      return;
    }
    onConfirm(note.trim());
  }

  return (
    <Dialog open onClose={onCancel} title={`${STATUS_LABELS[status]}: ${taskTitle}`}>
      <Label htmlFor="task-status-note" className="block">
        {need?.label ?? "Note"}
      </Label>
      <Textarea
        id="task-status-note"
        ref={box}
        value={note}
        onChange={(e) => {
          setNote(e.target.value);
          setError(null);
        }}
        maxLength={COMMENT_MAX - 20}
        placeholder={need?.placeholder}
        className="mt-1"
      />
      <p className="mt-1 text-xs text-subtle">Kept as a comment on the task. Whoever set it and whoever it&apos;s for are told.</p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Back
        </Button>
        <Button type="button" size="sm" variant={status === "CANCELLED" ? "danger" : "primary"} onClick={confirm}>
          {status === "CANCELLED" ? "Cancel the task" : "Ask for help"}
        </Button>
      </div>
    </Dialog>
  );
}
