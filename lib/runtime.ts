import { readConfig } from "./config";
import { Store } from "./db";
import { createModels } from "./models";
import { MockIncidentProvider } from "./tools";
import { TriageService } from "./triage";

const globalRuntime = globalThis as typeof globalThis & {
  triageService?: TriageService;
};
export function service() {
  if (!globalRuntime.triageService) {
    const c = readConfig();
    globalRuntime.triageService = new TriageService(
      new Store(c.DATABASE_PATH),
      createModels(c),
      new MockIncidentProvider(
        c.INCIDENT_DATABASE_PATH,
        c.INCIDENT_MODE,
        c.INCIDENT_LATENCY_MS,
      ),
    );
  }
  return globalRuntime.triageService;
}
