import { usePaseo } from "@getpaseo/plugin/client";
import { SettingsRow, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { OPENCODE_LABEL, OPENCODE_PROVIDER } from "../shared/model";
import type { Preferences } from "../shared/preferences";

interface CatalogModel {
  id: string;
  label: string;
  isDefault?: boolean;
  thinkingOptions?: Array<{ id: string; label: string }>;
}

type Catalog =
  | { status: "loading" }
  | { status: "ready"; models: CatalogModel[] }
  | { status: "error"; message: string }
  | { status: "empty" };

/** Where a stopped Claude chat continues when the fork option is on. Rendered under the fork toggle. */
export function ForkDestinationRows({
  values,
  saving,
  onSave,
}: {
  values: Preferences;
  saving: boolean;
  onSave(patch: Partial<Preferences>): void;
}) {
  const destinationEnabled = !saving && values.forkOtherProvider && values.autoSwitch;
  return (
    <SettingsSelect
      key="destination"
      label="Fork a stopped Claude chat to"
      hint={
        values.claudeForkDestination === "opencode"
          ? "Applies when every Claude account is out. OpenCode runs this host's permission policy, so Build can edit files and run shell without asking. That can allow more than Claude does."
          : "Applies when every Claude account is out. ChatGPT uses the account with the most room left."
      }
      value={values.claudeForkDestination}
      options={[
        { label: "ChatGPT", value: "codex" },
        { label: OPENCODE_LABEL, value: "opencode" },
      ]}
      disabled={!destinationEnabled}
      onValueChange={(claudeForkDestination) => onSave({ claudeForkDestination })}
    />
  );
}

/**
 * The OpenCode model and thinking option, read from this host's catalog. Always visible and editable:
 * a hand "Continue on OpenCode" uses them in every state, and the automatic fork uses them when its
 * destination is OpenCode.
 */
export function OpenCodeForkRows({
  values,
  saving,
  onSave,
}: {
  values: Preferences;
  saving: boolean;
  onSave(patch: Partial<Preferences>): void;
}) {
  const paseo = usePaseo();
  const [catalog, setCatalog] = useState<Catalog>({ status: "loading" });
  useEffect(() => {
    let live = true;
    paseo.providers
      .listModels(OPENCODE_PROVIDER)
      // A response with no models field and one with an empty list both mean: nothing to pick from.
      .then((result) => {
        if (!live) return;
        if (result.error) setCatalog({ status: "error", message: String(result.error) });
        else setCatalog((result.models ?? []).length > 0 ? { status: "ready", models: result.models ?? [] } : { status: "empty" });
      })
      .catch((error: unknown) => {
        if (live) setCatalog({ status: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      live = false;
    };
  }, [paseo]);

  if (catalog.status !== "ready") {
    const hint =
      catalog.status === "loading"
        ? "Loading this host's OpenCode catalog…"
        : catalog.status === "empty"
          ? "This host's OpenCode reported no models."
          : `Couldn't read this host's OpenCode models: ${catalog.message}`;
    return <SettingsRow label="OpenCode model" hint={hint} />;
  }

  const hostDefault = catalog.models.find((entry) => entry.isDefault);
  const saved = values.forkOpenCodeModel ? catalog.models.find((entry) => entry.id === values.forkOpenCodeModel) : undefined;
  // The model a fork would use: the saved one, else the one the host marks default. Never a guess.
  const model = values.forkOpenCodeModel ? saved : hostDefault;
  const rows = [
    <SettingsSelect
      key="model"
      label="OpenCode model"
      hint={
        values.forkOpenCodeModel && !saved
          ? "That model is no longer in this host's catalog; pick another."
          : !hostDefault && !values.forkOpenCodeModel
            ? "This host marks no OpenCode default; pick a model."
            : "Used by Continue on OpenCode in the account menu, and by the automatic fork when its destination is OpenCode."
      }
      value={values.forkOpenCodeModel}
      options={[
        ...(hostDefault ? [{ label: "Host default", value: "" }] : []),
        ...catalog.models.map((entry) => ({ label: entry.label, value: entry.id })),
      ]}
      disabled={saving}
      onValueChange={(forkOpenCodeModel) => {
        // A thinking option the newly chosen model doesn't offer can't stand.
        const next = forkOpenCodeModel ? catalog.models.find((entry) => entry.id === forkOpenCodeModel) : hostDefault;
        const keep = next?.thinkingOptions?.some((option) => option.id === values.forkOpenCodeThinking);
        onSave(keep ? { forkOpenCodeModel } : { forkOpenCodeModel, forkOpenCodeThinking: "" });
      }}
    />,
    <SettingsSelect
      key="thinking"
      label="OpenCode thinking"
      hint={
        !model
          ? "Pick a model above to choose its thinking option."
          : values.forkOpenCodeModel
            ? "How hard the model thinks on the fork. Empty uses the model's default."
            : `How hard the host default, “${model.label}”, thinks on the fork. Empty uses the model's default.`
      }
      value={values.forkOpenCodeThinking}
      options={[
        { label: "Model default", value: "" },
        ...(model?.thinkingOptions ?? []).map((option) => ({ label: option.label, value: option.id })),
      ]}
      disabled={saving || !model}
      onValueChange={(forkOpenCodeThinking) => onSave({ forkOpenCodeThinking })}
    />,
  ];
  return <>{rows}</>;
}
