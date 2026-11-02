// Browser APIs the DOM lib that ships with TypeScript does not describe yet.

interface FileSystemSyncAccessHandle {
  read(buffer: ArrayBufferView, options?: { at?: number }): number;
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
  truncate(newSize: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

interface FileSystemFileHandle {
  /** Workers only. Takes an exclusive lock on the file until close(). */
  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
  /** Chrome 110+. Moves within the origin private file system. */
  move(destinationDirectory: FileSystemDirectoryHandle, newName?: string): Promise<void>;
}

interface NavigatorUABrandVersion {
  brand: string;
  version: string;
}

interface NavigatorUAData {
  brands: NavigatorUABrandVersion[];
  mobile: boolean;
  platform: string;
}

interface Navigator {
  readonly userAgentData?: NavigatorUAData;
  readonly gpu?: { requestAdapter(options?: object): Promise<object | null> };
}

declare const __BUILD_HASH__: string;
