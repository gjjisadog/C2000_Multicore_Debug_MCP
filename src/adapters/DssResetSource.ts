// Shared ES5 source for both Rhino DSS bridges. Do not use modern JS in this string.
export const dssResetHelperSource = String.raw`
function applyTargetReset(session, resetType) {
  var type = resetType || "default";
  var evidence = { requestedResetType: type, effectiveResetType: type };
  if (type === "system" || type === "cpu") {
    var requiredName = type === "system" ? "System Reset" : "CPU Reset";
    var supported = [];
    var selected = null;
    var count = session.target.getNumResetTypes();
    for (var i = 0; i < count; i++) {
      var candidate = session.target.getResetType(i);
      var name = String(candidate.getName());
      var allowed = candidate.isAllowed();
      supported.push({ index: i, name: name, allowed: allowed });
      if (name.toLowerCase() === requiredName.toLowerCase()) {
        if (selected !== null) {
          throw new Error("Ambiguous reset type: " + requiredName);
        }
        selected = { reset: candidate, index: i, name: name, allowed: allowed };
      }
    }
    if (selected === null || !selected.allowed) {
      throw new Error("Requested reset unavailable: " + requiredName +
        "; supported=" + JSON.stringify(supported));
    }
    evidence.resetName = selected.name;
    evidence.resetIndex = selected.index;
    evidence.supportedResets = supported;
    evidence.mechanism = "ResetType.issueReset";
    selected.reset.issueReset();
  } else if (type === "restart") {
    evidence.resetName = "Program Restart";
    evidence.mechanism = "target.restart";
    session.target.restart();
  } else if (type === "default") {
    evidence.resetName = "CCS default reset";
    evidence.mechanism = "target.reset";
    session.target.reset();
  } else {
    throw new Error("Unsupported reset type: " + type);
  }
  // DSS issueReset is asynchronous. Observe status only (never PC), with a
  // bounded poll. A halted debug core is not proof of physical XRS/cold boot.
  var lastStateError = "";
  for (var poll = 0; poll < 100; poll++) {
    try {
      if (session.target.isConnected() && session.target.isHalted()) {
        evidence.completion = "halt-observed";
        evidence.state = "Halted";
        return evidence;
      }
    } catch (stateError) {
      lastStateError = String(stateError);
    }
    java.lang.Thread.sleep(10);
  }
  throw new Error("Reset completion not observed: " + JSON.stringify(evidence) +
    "; lastStateError=" + lastStateError);
}
`;
