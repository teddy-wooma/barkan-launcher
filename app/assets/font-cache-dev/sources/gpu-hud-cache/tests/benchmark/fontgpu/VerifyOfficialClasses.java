package benchmark.fontgpu;

/** Resolves every pinned method/field without initializing GL or game main. */
public final class VerifyOfficialClasses {
    public static void main(String[] args) {
        synchronized(FontGpuCache.LOCK){FontGpuCache.api();}
        System.out.println("{\"status\":\"PASS\",\"official_reflection_resolved\":true,\"minecraft_main_launched\":false,\"stats\":"+FontGpuCache.snapshotJson()+"}");
    }
}
