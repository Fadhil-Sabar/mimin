import { describe, expect, test } from "bun:test";
import {
  INJECTION_WARNING_NOTICE,
  withInjectionWarning,
} from "../src/agent/security-prompt.js";

describe("withInjectionWarning", () => {
  test("prepends the security notice when enabled", () => {
    const result = withInjectionWarning("BASE PROMPT", { injectionWarning: true });
    expect(result).toContain(INJECTION_WARNING_NOTICE);
    expect(result).toContain("BASE PROMPT");
    expect(result.indexOf(INJECTION_WARNING_NOTICE)).toBeLessThan(
      result.indexOf("BASE PROMPT"),
    );
  });

  test("returns the base prompt unchanged when disabled", () => {
    const result = withInjectionWarning("BASE PROMPT", { injectionWarning: false });
    expect(result).toBe("BASE PROMPT");
  });

  test("returns the base prompt unchanged when security is undefined", () => {
    const result = withInjectionWarning("BASE PROMPT", undefined);
    expect(result).toBe("BASE PROMPT");
  });
});
