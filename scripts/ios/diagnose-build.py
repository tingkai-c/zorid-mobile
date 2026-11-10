"""Translate Xcode errors to safe diagnostic categories; never echo signing metadata.

Regex-only redaction of raw signing errors is insufficient: free-form profile and
certificate names may themselves contain personal data. Match error lines but emit
only fixed explanations, including a line number for local runner diagnostics.
"""
import re
import sys
from pathlib import Path

RULES = [
    (r'app.?groups?|com\.apple\.security\.application-groups', 'App Group entitlement/registration failed. Check both app identifiers and their shared group.'),
    (r'no profiles|requires a provisioning profile|couldn.t find.*profile', 'A required provisioning profile is missing. Check each app/extension bundle ID.'),
    (r'profile.*(doesn.t|does not|doesn’t).*include|profile.*doesn.t support', 'A profile does not authorize the requested entitlement, certificate or device.'),
    (r'no signing certificate|certificate.*(expired|invalid|not found)|private key', 'A signing certificate/private key is missing, expired or incompatible.'),
    (r'authentication|unauthorized|not authorized|forbidden|permission|access denied', 'Developer Resources authentication or permissions failed. Check the team API key access.'),
    (r'communication with apple|connection|timed out|network', 'Apple provisioning service or network communication failed.'),
    (r'conflicting provisioning|automatic.*manual|manually.*automatically', 'Automatic and manual signing settings conflict.'),
    (r'provision|signing|codesign', 'Signing failed. Check team, bundle IDs, profiles and distribution certificate compatibility.'),
    (r'no such module|module.*not found', 'A native module could not be resolved. Check generated native dependencies and CocoaPods.'),
    (r'cannot find|undeclared|no member|has no member', 'Native compilation failed because a symbol or API is unavailable.'),
    (r'undefined symbol|linker command|duplicate symbol', 'Native linking failed; inspect dependency and target linkage.'),
    (r'phase.?script|script execution', 'A native build script failed; check bundling and dependency preparation.'),
]

def diagnostics(text):
    seen = set()
    for number, line in enumerate(text.splitlines(), 1):
        if not re.search(r'error:|error |failed|failure', line, re.I):
            continue
        message = next((message for pattern, message in RULES if re.search(pattern, line, re.I)),
                       'An unclassified native build error occurred; raw output is withheld because it may contain provisioning metadata.')
        if message not in seen:
            seen.add(message)
            yield f'Xcode diagnostic (private log line {number}): {message}'
    if not seen:
        yield 'Xcode failed without a recognized error line; raw signing logs are withheld.'

if __name__ == '__main__':
    for diagnostic in diagnostics(Path(sys.argv[1]).read_text(errors='replace')):
        print(diagnostic)
