using System.Text.Json;
using Openlock.Shell;

var root = Path.Combine(Path.GetTempPath(), "openlock-layout-tests-" + Guid.NewGuid().ToString("N"));
var layouts = new LayoutProfiles(root);
var checks = 0;

void Check(bool condition, string name)
{
    checks++;
    if (!condition)
        throw new InvalidOperationException("FAILED: " + name);
    Console.WriteLine("ok " + checks + " - " + name);
}

var parsed = layouts.TryParse(
    "deadlock@settings,300,200,700,500",
    out var scheme,
    out var windows,
    out var state,
    out var why);
Check(parsed && scheme == "deadlock" && windows.Count == 1 && windows["settings"].X == 300,
    "parses one non-default snapshot");

var savedState = new LayoutProfiles.LayoutState
{
    Active = "settings",
    Tab = "inventory",
    Pinned = ["settings"],
    Minimized = ["console"],
};
Check(layouts.Save(scheme, windows, savedState, out why), "saves profile: " + why);
var path = layouts.PathFor("deadlock");
Check(path.Length > 0 && File.Exists(path), "writes inside the profile directory");
Check(path.StartsWith(Path.GetFullPath(Path.Combine(root, "layouts")) + Path.DirectorySeparatorChar),
    "profile path is contained");

using (var document = JsonDocument.Parse(File.ReadAllText(path)))
{
    var saved = document.RootElement.GetProperty("windows").GetProperty("settings");
    Check(saved.GetProperty("x").GetInt32() == 300
          && saved.GetProperty("y").GetInt32() == 200
          && saved.GetProperty("w").GetInt32() == 700
          && saved.GetProperty("h").GetInt32() == 500,
        "file carries the non-default geometry");
    var savedRoot = document.RootElement;
    Check(savedRoot.GetProperty("active").GetString() == "settings"
          && savedRoot.GetProperty("tab").GetString() == "inventory"
          && savedRoot.GetProperty("pinned").GetArrayLength() == 1
          && savedRoot.GetProperty("minimized").GetArrayLength() == 1,
        "file carries the taskbar and pin state");
}

Check(layouts.Export(scheme, out var exported, out why), "exports profile: " + why);
Check(exported.Length > 0 && File.Exists(exported), "export writes a portable file");
Check(exported.StartsWith(Path.GetFullPath(Path.Combine(root, "layouts", "exports")) + Path.DirectorySeparatorChar),
    "export stays inside the layouts directory");
using (var document = JsonDocument.Parse(File.ReadAllText(exported)))
{
    Check(document.RootElement.GetProperty("active").GetString() == "settings"
          && document.RootElement.GetProperty("windows").TryGetProperty("settings", out _),
        "export carries geometry and arrangement");
}

using (var payload = JsonDocument.Parse(layouts.PayloadJson()))
{
    Check(payload.RootElement.GetProperty("format").GetString() == LayoutProfiles.PayloadFormat,
        "payload has the profile format");
    Check(payload.RootElement.GetProperty("profiles").TryGetProperty("deadlock", out _),
        "payload carries the scheme");
}

Check(!layouts.TryParse("../evil@settings,1,2,700,500", out _, out _, out _, out _),
    "refuses traversal in scheme");
Check(layouts.TryParse("deadlock@active=settings@tab=inventory@pin=abilities@min=console@cell:abilities:health,10,20,40,32",
        out _, out var cellWindows, out var arrangement, out why)
      && cellWindows["cell:abilities:health"].W == 40
      && arrangement.Active == "settings"
      && arrangement.Tab == "inventory"
      && arrangement.Pinned.Count == 1
      && arrangement.Minimized.Count == 1,
    "accepts a split-cell row and arrangement state");
Check(layouts.TryParse("deadlock@cell:abilities:health:label:t,10,20,40,32",
        out _, out var nestedCells, out _, out why)
      && nestedCells.Count == 1
      && nestedCells.ContainsKey("cell:abilities:health:label:t"),
    "accepts a nested cell row");
Check(!layouts.TryParse("deadlock@settings,0,0,10,10", out _, out _, out _, out _),
    "refuses undersized geometry for a whole window");
Check(!layouts.TryParse("deadlock@bad id,0,0,700,500", out _, out _, out _, out _),
    "refuses unsafe window ids");
Check(!layouts.TryParse("deadlock@active=bad id@settings,0,0,700,500", out _, out _, out _, out _),
    "refuses unsafe arrangement ids");
Check(!layouts.TryParse("deadlock@", out _, out _, out _, out _),
    "refuses an empty snapshot");

var holo = Path.Combine(layouts.DirectoryPath, "holo.layout.json");
Directory.CreateDirectory(layouts.DirectoryPath);
File.WriteAllText(holo, "not json");
using (var payload = JsonDocument.Parse(layouts.PayloadJson()))
{
    var notices = payload.RootElement.GetProperty("notices");
    Check(notices.EnumerateArray().Any(n => n.GetString()!.Contains("holo.layout.json")),
        "malformed profile is reported as a notice");
    Check(payload.RootElement.GetProperty("profiles").TryGetProperty("deadlock", out _),
        "a malformed sibling does not remove valid profiles");
}

// --- the Popit surface arrangement --------------------------------------
Check(layouts.TryParse(
        "deadlock@popit=columns:2;width:420;frame:vita;mode:play;order:console+settings@settings,300,200,700,500",
        out _, out var popitWindows, out var popitState, out why)
      && popitState.Popit is not null
      && popitState.Popit.Columns == 2
      && popitState.Popit.Width == 420
      && popitState.Popit.Frame == "vita"
      && popitState.Popit.Mode == "play"
      && popitState.Popit.Order.SequenceEqual(["console", "settings"])
      && popitWindows.Count == 1,
    "parses the popit row beside geometry: " + why);

Check(layouts.Save(scheme, popitWindows, popitState, out why), "saves popit arrangement: " + why);
using (var document = JsonDocument.Parse(File.ReadAllText(path)))
{
    var popit = document.RootElement.GetProperty("popit");
    Check(popit.GetProperty("columns").GetInt32() == 2
          && popit.GetProperty("width").GetInt32() == 420
          && popit.GetProperty("frame").GetString() == "vita"
          && popit.GetProperty("mode").GetString() == "play"
          && popit.GetProperty("order").GetArrayLength() == 2,
        "file carries the popit arrangement");
}

using (var payload = JsonDocument.Parse(layouts.PayloadJson()))
{
    var popit = payload.RootElement.GetProperty("profiles").GetProperty("deadlock").GetProperty("popit");
    Check(popit.GetProperty("columns").GetInt32() == 2
          && popit.GetProperty("frame").GetString() == "vita",
        "payload carries the popit arrangement to the shell");
}

Check(!layouts.TryParse("deadlock@popit=columns:9@settings,300,200,700,500", out _, out _, out _, out _),
    "refuses more than four popit columns");
Check(!layouts.TryParse("deadlock@popit=width:10000@settings,300,200,700,500", out _, out _, out _, out _),
    "refuses a popit width outside the frame range");
Check(!layouts.TryParse("deadlock@popit=frame:windows@settings,300,200,700,500", out _, out _, out _, out _),
    "refuses an unknown popit frame");
Check(!layouts.TryParse("deadlock@popit=order:bad id@settings,300,200,700,500", out _, out _, out _, out _),
    "refuses an unsafe popit tile id");
Check(!layouts.TryParse("deadlock@popit=columns:2;columns:3@settings,300,200,700,500", out _, out _, out _, out _),
    "refuses a repeated popit field");

// --- a cell's Popit edit travels in its own row --------------------------
Check(layouts.TryParse(
        "deadlock@cell:abilities:health,10,20,40,32,m1c2d3r12b2o90@settings,300,200,700,500",
        out _, out var styledWindows, out _, out why)
      && styledWindows["cell:abilities:health"].Popit == "m1c2d3r12b2o90",
    "parses a Popit style beside a cell rect: " + why);
Check(layouts.Save(scheme, styledWindows, new LayoutProfiles.LayoutState(), out why),
    "saves a Popit-styled cell: " + why);
using (var document = JsonDocument.Parse(File.ReadAllText(path)))
{
    var cell = document.RootElement.GetProperty("windows").GetProperty("cell:abilities:health");
    Check(cell.GetProperty("popit").GetString() == "m1c2d3r12b2o90",
        "file carries the cell's Popit edit");
}
using (var payload = JsonDocument.Parse(layouts.PayloadJson()))
{
    var cell = payload.RootElement.GetProperty("profiles").GetProperty("deadlock")
        .GetProperty("windows").GetProperty("cell:abilities:health");
    Check(cell.GetProperty("popit").GetString() == "m1c2d3r12b2o90",
        "payload carries the cell's Popit edit to the shell");
}
Check(!layouts.TryParse("deadlock@settings,300,200,700,500,m9c0d0r0b0o100", out _, out _, out _, out _),
    "refuses an unknown Popit material");
Check(!layouts.TryParse("deadlock@settings,300,200,700,500,m1c8d0r0b0o100", out _, out _, out _, out _),
    "refuses an unknown Player Colour");
Check(!layouts.TryParse("deadlock@settings,300,200,700,500,background:url(x)", out _, out _, out _, out _),
    "refuses free-form CSS in the style field");

Check(layouts.Reset("deadlock", out why), "resets profile: " + why);
Check(!File.Exists(path), "reset removes the profile file");
Check(layouts.PathFor("..") == "", "invalid scheme has no path");

try
{
    Directory.Delete(root, recursive: true);
}
catch
{
}

Console.WriteLine($"all {checks} checks passed");
