import type {
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettingsPatch,
  ServerProvider,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";

export type AgentUiMode = "all" | "pi";

export interface ProviderBackedThread {
  readonly modelSelection: ModelSelection;
  readonly session: { readonly providerInstanceId?: ProviderInstanceId | undefined } | null;
}

const PI_DRIVER = "piAgent";

export function isProviderVisible(mode: AgentUiMode, driverKind: ProviderDriverKind): boolean {
  return mode === "all" || driverKind === PI_DRIVER;
}

export function filterProviderInstances<T extends { readonly driver: ProviderDriverKind }>(
  mode: AgentUiMode,
  instances: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return mode === "all" ? instances : instances.filter((instance) => instance.driver === PI_DRIVER);
}

export function effectiveThreadProviderInstanceId(
  thread: ProviderBackedThread,
): ProviderInstanceId {
  return thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
}

export function isThreadVisible(
  mode: AgentUiMode,
  thread: ProviderBackedThread,
  providerInstances: ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver">>,
): boolean {
  if (mode === "all") return true;
  const instanceId = effectiveThreadProviderInstanceId(thread);
  return providerInstances.some(
    (provider) => provider.instanceId === instanceId && provider.driver === PI_DRIVER,
  );
}

export function filterThreadRefs<T extends ProviderBackedThread>(
  mode: AgentUiMode,
  threads: ReadonlyArray<T>,
  providerInstances: ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver">>,
): ReadonlyArray<T> {
  return mode === "all"
    ? threads
    : threads.filter((thread) => isThreadVisible(mode, thread, providerInstances));
}

export function resolveModeModelSelection(
  mode: AgentUiMode,
  current: ModelSelection,
  lastPiSelection: ModelSelection | null,
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection | null {
  if (mode === "all") return current;
  const readyPiProviders = providers.filter(
    (provider) =>
      provider.driver === PI_DRIVER &&
      provider.enabled &&
      provider.installed &&
      provider.status === "ready" &&
      provider.models.length > 0,
  );
  if (lastPiSelection) {
    const remembered = readyPiProviders.find(
      (provider) =>
        provider.instanceId === lastPiSelection.instanceId &&
        provider.models.some((model) => model.slug === lastPiSelection.model),
    );
    if (remembered) return lastPiSelection;
  }
  const provider = readyPiProviders[0];
  if (!provider) return null;
  const model = provider.models.find((candidate) => candidate.isDefault) ?? provider.models[0];
  return model ? { instanceId: provider.instanceId, model: model.slug } : null;
}

export interface PiModeWriterRestore {
  readonly previousTextGenerationModelSelection: ModelSelection;
  readonly previousSourceControlWriterModelSelection: ModelSelection | null;
  readonly appliedPiSelection: ModelSelection;
}

export function resolvePiModeWriterRestoration(
  currentTextGeneration: ModelSelection,
  currentSourceControlWriter: ModelSelection | null,
  restore: PiModeWriterRestore | null,
): Pick<ServerSettingsPatch, "textGenerationModelSelection" | "sourceControlWriterModelSelection"> {
  if (!restore) return {};
  return {
    ...(Equal.equals(currentTextGeneration, restore.appliedPiSelection)
      ? { textGenerationModelSelection: restore.previousTextGenerationModelSelection }
      : {}),
    ...(Equal.equals(currentSourceControlWriter, restore.appliedPiSelection)
      ? { sourceControlWriterModelSelection: restore.previousSourceControlWriterModelSelection }
      : {}),
  };
}
