import assert from "node:assert/strict";
import test from "node:test";

import { findUnapprovedEndpointLiterals } from "../scripts/endpoint-literals.mjs";

test("endpoint scanning catches uppercase schemes and bracketed hosts", () => {
  const uppercaseIpv6 = ["HT", "TPS://[2001:db8::1]/v1"].join("");
  const bracketedDomain = ["ht", "tps://unapproved.example"].join("");
  const bracketedIpv6 = ["ht", "tps://[2001:db8::2]"].join("");
  const uppercaseApproved = ["HT", "TPS://API.OPENAI.COM/v1"].join("");

  const approvedHosts = new Set(["api.openai.com"]);

  assert.deepEqual(
    findUnapprovedEndpointLiterals(
      `unapproved=${uppercaseIpv6}; [${bracketedDomain}] [${bracketedIpv6}] approved=${uppercaseApproved}.`,
      approvedHosts,
    ),
    [uppercaseIpv6, bracketedDomain, bracketedIpv6],
  );
  assert.deepEqual(
    findUnapprovedEndpointLiterals(`[${bracketedDomain}][label]`, approvedHosts),
    [bracketedDomain],
  );
  assert.deepEqual(
    findUnapprovedEndpointLiterals(
      `[${uppercaseApproved}][${bracketedDomain}]`,
      approvedHosts,
    ),
    [bracketedDomain],
  );
});
