import { formatConsoleLine } from "./format.js";
import type { AlertEnvelope, Notifier } from "./types.js";

export class ConsoleNotifier implements Notifier {
  readonly channel = "console";
  private readonly write: (text: string) => void;

  constructor(write: (text: string) => void = (text) => process.stdout.write(text)) {
    this.write = write;
  }

  async send(envelope: AlertEnvelope): Promise<void> {
    this.write(formatConsoleLine(envelope));
  }
}
