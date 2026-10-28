using System.Text;

namespace Openlock;

/// <summary>
/// Writes the mode's evidence lines to stdout and to <c>openlock.log</c> beside the plugin DLL.
///
/// <para>
/// The file exists because the server console belongs to the person running the server: reading
/// engine state back is only evidence if it lands somewhere that outlives the window and can be
/// diffed afterwards. Every line written here is a value read from the engine, not a restatement
/// of a call the plugin made.
/// </para>
/// </summary>
internal static class Log
{
    private static readonly object Gate = new();
    private static readonly string FilePath = ResolvePath();

    public static string Path => FilePath;

    private static string ResolvePath()
    {
        try
        {
            var dir = System.IO.Path.GetDirectoryName(typeof(Log).Assembly.Location);
            if (!string.IsNullOrEmpty(dir))
                return System.IO.Path.Combine(dir, "openlock.log");
        }
        catch
        {
            // Fall through to the working directory.
        }

        return "openlock.log";
    }

    public static void Write(string line)
    {
        Console.WriteLine(line);

        try
        {
            lock (Gate)
                File.AppendAllText(FilePath, $"{DateTime.Now:HH:mm:ss.fff} {line}\n", Encoding.UTF8);
        }
        catch
        {
            // Logging must never take the server down; stdout already has the line.
        }
    }

    public static void Banner(string text)
    {
        Write("");
        Write($"=== {text} ===");
    }
}
