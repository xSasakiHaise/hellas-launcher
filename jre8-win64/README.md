# Bundled Java 8 Runtime Placeholder

Place a Java 8 runtime in this directory before packaging or distributing the launcher. The build expects a standard layout such
as `bin/java.exe` (Windows) or `bin/java` (other platforms). You may also point the launcher at another Java 8 installation
during development by setting the `BUNDLED_JAVA_PATH` environment variable.
