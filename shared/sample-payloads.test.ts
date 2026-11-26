import { describe, expect, it } from "vitest";
import { StateViewSchema } from "./model";
import { sampleState, sampleSwitchTimelineItems } from "./sample-payloads.test-support";
import { SWITCH_ROW_KIND, SWITCH_ROW_VERSION, SwitchRowSchema } from "./timeline";

describe("sample payloads", () => {
  it("matches the zerosub.state RPC output", () => {
    expect(StateViewSchema.parse(sampleState)).toEqual(sampleState);
  });

  it.each(sampleSwitchTimelineItems)("matches the $data.outcome switch timeline item", (item) => {
    expect(item).toMatchObject({
      type: "plugin",
      id: `switch-${Date.parse(item.data.at)}`,
      pluginId: "zerosub",
      kind: SWITCH_ROW_KIND,
      version: SWITCH_ROW_VERSION,
    });
    expect(SwitchRowSchema.parse(item.data)).toEqual(item.data);
  });
});
