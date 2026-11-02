import { SpeedMeter, formatBytes, formatEta, formatSpeed, percent } from '../format';
import type { InstallPhase, ProgressMessage } from './protocol';

/** Everything the download screen shows. */
export interface DownloadViewState {
  phase: InstallPhase | 'up-to-date';
  status: string;
  /** True while there is no byte count to show yet. */
  indeterminate: boolean;
  percent: number;
  bytesText: string;
  speedText: string;
  etaText: string;
  filesText: string;
  currentFile: string;
}

const STATUS: Record<InstallPhase, string> = {
  waiting: 'Waiting for another tab or a recent session to release the game files (up to 30 seconds)...',
  checking: 'Checking for updates...',
  reconciling: 'Checking files already on this computer...',
  downloading: 'Downloading game files',
  finalizing: 'Finishing up...',
};

/** Turns worker events into the numbers on screen. Time comes from the caller so tests can fake it. */
export class ProgressTracker {
  private phase: InstallPhase = 'checking';
  private upToDate = false;
  private readonly meter = new SpeedMeter();
  private last: ProgressMessage | null = null;

  setPhase(phase: InstallPhase): void {
    this.phase = phase;
  }

  setUpToDate(): void {
    this.upToDate = true;
  }

  update(progress: ProgressMessage, now: number): void {
    this.last = progress;
    this.meter.add(now, progress.receivedBytes);
  }

  state(): DownloadViewState {
    const p = this.last;
    if (this.upToDate) {
      return {
        phase: 'up-to-date',
        status: 'Game files are up to date',
        indeterminate: false,
        percent: 100,
        bytesText: '',
        speedText: '-',
        etaText: '-',
        filesText: '',
        currentFile: '',
      };
    }
    if (!p || this.phase !== 'downloading') {
      return {
        phase: this.phase,
        status: STATUS[this.phase],
        indeterminate: this.phase !== 'finalizing' || !p,
        percent: this.phase === 'finalizing' ? 100 : 0,
        bytesText: p ? `${formatBytes(p.receivedBytes)} of ${formatBytes(p.totalBytes)}` : '',
        speedText: '-',
        etaText: '-',
        filesText: p ? `${p.filesDone} of ${p.filesTotal} files` : '',
        currentFile: '',
      };
    }
    const remaining = Math.max(0, p.totalBytes - p.receivedBytes);
    const current = p.active[0] ?? '';
    return {
      phase: 'downloading',
      status: p.verifying ? 'Verifying downloaded files' : STATUS.downloading,
      indeterminate: false,
      percent: percent(p.receivedBytes, p.totalBytes),
      bytesText: `${formatBytes(p.receivedBytes)} of ${formatBytes(p.totalBytes)}`,
      speedText: formatSpeed(this.meter.bytesPerSecond()),
      etaText: formatEta(this.meter.etaSeconds(remaining)),
      filesText: `${p.filesDone} of ${p.filesTotal} files`,
      currentFile: current,
    };
  }
}
