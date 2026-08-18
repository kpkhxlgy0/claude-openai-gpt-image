const URL_SCHEME_PATTERN = /https?:\/\//gi;
const URL_TERMINATOR_PATTERN = /[\s"'`<>)};,]/;

function extractEndpointCandidate(text, start, schemeLength) {
  const authorityStart = start + schemeLength;
  let inAuthority = true;
  let inIpv6Address = false;
  let end = authorityStart;

  for (; end < text.length; end += 1) {
    const character = text[end];
    if (URL_TERMINATOR_PATTERN.test(character)) {
      break;
    }

    if (character === "[") {
      if (!inAuthority || inIpv6Address || end !== authorityStart) {
        break;
      }
      inIpv6Address = true;
      continue;
    }

    if (character === "]") {
      if (!inAuthority || !inIpv6Address) {
        break;
      }
      inIpv6Address = false;
      continue;
    }

    if (
      inAuthority &&
      !inIpv6Address &&
      (character === "/" || character === "?" || character === "#")
    ) {
      inAuthority = false;
    }
  }

  return text.slice(start, end);
}

function parseEndpointCandidate(literal) {
  try {
    return {
      literal,
      hostname: new URL(literal).hostname.toLowerCase(),
    };
  } catch {
    return undefined;
  }
}

export function findUnapprovedEndpointLiterals(text, approvedHosts) {
  const unapproved = [];
  URL_SCHEME_PATTERN.lastIndex = 0;

  for (const match of text.matchAll(URL_SCHEME_PATTERN)) {
    if (match.index === undefined) {
      continue;
    }
    const literal = extractEndpointCandidate(text, match.index, match[0].length);
    const endpoint = parseEndpointCandidate(literal);
    if (endpoint !== undefined && !approvedHosts.has(endpoint.hostname)) {
      unapproved.push(endpoint.literal);
    }
  }

  return unapproved;
}
