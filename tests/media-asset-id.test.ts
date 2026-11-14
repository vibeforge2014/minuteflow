import { expect, it } from "vitest";
import { isMediaAssetId } from "../electron/services/media.mjs";
it("accepts import UUIDs and archived recording tracks without allowing arbitrary paths", () => {
  const id = '80f936ea-f769-478b-9f5a-4d1622109ab9';
  for (const value of [id, `${id}:microphone`, `${id}:system`]) expect(isMediaAssetId(value)).toBe(true);
  for (const value of [null, '', '../audio', `${id}:mixed`, `${id}:microphone/extra`, `${id}:system:extra`]) expect(isMediaAssetId(value)).toBe(false);
});
