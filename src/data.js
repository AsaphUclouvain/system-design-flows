/* =====================================================================
   FLOW DATA
   Every flow is one flow({...}) call. Add a flow by copying an existing
   one and changing it; the app picks it up automatically.
   The full field reference is on the "Edit & host" page of the app.
   ===================================================================== */
window.SD_FLOWS = [];
window.SD_GLOSSARY = {};
function flow(f) { window.SD_FLOWS.push(f); }
function terms(o) { Object.keys(o).forEach(function (k) { window.SD_GLOSSARY[k.toLowerCase()] = o[k]; }); }
