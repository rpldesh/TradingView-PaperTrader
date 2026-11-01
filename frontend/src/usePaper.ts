import { useCallback, useEffect, useRef, useState } from 'react';
import { loadState, saveState } from './api';
import { newPaperState, type PaperState } from './paper';

const SAVE_THROTTLE_MS = 1500;

/** A paper account persisted to the backend under `paper-<name>`. */
export function usePaper(name: string) {
  const [state, setState] = useState<PaperState>(() => newPaperState());
  const ref = useRef(state);
  const loaded = useRef(false);
  const saveTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    loadState<PaperState>(`paper-${name}`).then((saved) => {
      if (saved) {
        ref.current = { ...newPaperState(), ...saved };
        setState(ref.current);
      }
      loaded.current = true;
    });
  }, [name]);

  useEffect(() => {
    const flush = () => {
      if (saveTimer.current === undefined) return;
      window.clearTimeout(saveTimer.current);
      saveTimer.current = undefined;
      saveState(`paper-${name}`, ref.current);
    };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [name]);

  const update = useCallback((fn: (s: PaperState) => PaperState) => {
    const next = fn(ref.current);
    if (next === ref.current) return;
    ref.current = next;
    setState(next);
    // Throttled rather than debounced, so a stream of live ticks still saves.
    if (loaded.current && saveTimer.current === undefined) {
      saveTimer.current = window.setTimeout(() => {
        saveTimer.current = undefined;
        saveState(`paper-${name}`, ref.current);
      }, SAVE_THROTTLE_MS);
    }
  }, [name]);

  return { state, ref, update };
}
