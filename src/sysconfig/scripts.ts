import type { InspectSysConfigInput, SysConfigChange } from "./SysConfigSchemas.js";

// These scripts run inside TI's configuration engine, with its real object
// setters, onChange callbacks, defaults and pin solver. No C/H text is edited.
const selectors = `
  function instance(ref) {
    var mod = system.modules[ref.moduleId];
    if (!mod) throw new Error("Unknown module: " + ref.moduleId);
    if (ref.moduleInstanceId === "$static") return mod.$static;
    var matches = mod.$instances.filter(function (item) { return item.$name === ref.moduleInstanceId; });
    if (matches.length !== 1) throw new Error("Unknown or ambiguous instance: " + ref.moduleInstanceId);
    return matches[0];
  }
  function parts(key) { return key.replace(/\\[(\\d+)\\]/g, ".$1").split("."); }
  function read(obj, key) { return parts(key).reduce(function (value, part) { return value[part]; }, obj); }
`;

export function changesScript(changes: SysConfigChange[]): string {
  return `\n// Applied through c2000_updateSysConfig; validated by TI SysConfig.\n(function () {${selectors}
  var operations = ${JSON.stringify(changes)}.map(function (change) {
    var value = change.value;
    if (value && typeof value === "object" && !Array.isArray(value)) value = instance(value);
    return { change: change, target: instance(change), value: value };
  });
  operations.forEach(function (operation) {
    var change = operation.change, obj = operation.target, keys = parts(change.configurable), key = keys.pop();
    keys.forEach(function (part) { obj = obj[part]; });
    if (obj == null || !(key in obj)) throw new Error("Unknown configurable: " + change.configurable);
    obj[key] = operation.value;
  });
})();\n`;
}

export function inspectionScript(input: InspectSysConfigInput, marker: string): string {
  return `\n(function () {${selectors}
  var requested = ${JSON.stringify(input.instances ?? [])};
  var moduleIds = ${JSON.stringify(input.moduleIds ?? [])};
  var ids = ${JSON.stringify(input.configurableIds ?? [])};
  function valueOf(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (value.$module && value.$name) return { moduleId: value.$module.$name, moduleInstanceId: value.$name };
      return undefined;
    }
    if (typeof value === "function") return undefined;
    return value;
  }
  function describe(obj, defs, prefix, result, depth) {
    if (depth > 4 || result.length >= 512) return;
    Object.keys(obj).forEach(function (key) {
      if (key[0] === "$" && key !== "$name" && key !== "$assign") return;
      var value = obj[key], id = prefix + key, def = defs && defs[key];
      if (value && typeof value === "object" && !Array.isArray(value) && !value.$module) {
        describe(value, null, id + ".", result, depth + 1); return;
      }
      var plain = valueOf(value);
      if (plain === undefined || result.length >= 512) return;
      result.push({ id: id, value: plain,
        displayName: def ? def.displayName : undefined,
        choices: def && Array.isArray(def.options) ? def.options : undefined });
    });
  }
  var modules = Object.keys(system.modules).filter(function (id) { return !moduleIds.length || moduleIds.indexOf(id) >= 0; }).map(function (id) {
    var mod = system.modules[id];
    return { moduleId: id, displayName: mod.displayName,
      instances: mod.$instances.length ? mod.$instances.map(function (obj) { return obj.$name; }) : ["$static"] };
  });
  var configuration = requested.map(function (ref) {
    var obj = instance(ref), mod = system.modules[ref.moduleId], fields = [];
    if (ids.length) fields = ids.map(function (key) { return { id: key, value: valueOf(read(obj, key)) }; });
    else describe(obj, mod.$configByName, "", fields, 0);
    return { moduleId: ref.moduleId, moduleInstanceId: ref.moduleInstanceId, configuration: fields };
  });
  console.log(${JSON.stringify(marker)} + JSON.stringify({ modules: modules, configuration: configuration }));
})();\n`;
}
