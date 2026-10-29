package benchmark.fontgpu;

import java.io.*;
import java.lang.reflect.*;
import java.nio.file.*;
import java.util.*;

/** Experimental, render-thread-only GPU storage sharing. Minecraft 1.21.11. */
public final class FontGpuCache {
    static final Object LOCK = new Object();
    static final Map<String,Long> COUNTERS = new TreeMap<>();
    static final IdentityHashMap<Object,Manager> MANAGERS = new IdentityHashMap<>();
    static final IdentityHashMap<Object,Binding> BINDINGS = new IdentityHashMap<>();
    // Pinned vanilla classes use Object identity equality; weak keys avoid retaining
    // closed FontSets/FontManagers over successive reloads.
    static final WeakHashMap<Object,Boolean> CLOSED_SOURCES = new WeakHashMap<>();
    static final WeakHashMap<Object,Boolean> CLOSED_MANAGERS = new WeakHashMap<>();
    static final ThreadLocal<Deque<Scope>> SCOPES = ThreadLocal.withInitial(ArrayDeque::new);
    static final ArrayDeque<Map<String,Object>> HISTORY = new ArrayDeque<>();
    static final ArrayDeque<String> ERRORS = new ArrayDeque<>();
    static boolean enabled = true, shareBitmapCells = true;
    static String poolPolicy="small-text";
    static int smallTextHeight=22, smallTextMaxWidth=32;
    static long sequence;
    static Path output;
    static Backend backend;

    private FontGpuCache() {}
    static void configure(boolean on, boolean cells, Path out) {
        configure(on,cells,out,"global",22,32);
    }
    static void configure(boolean on, boolean cells, Path out,String policy,int textHeight,int maxWidth) { synchronized(LOCK) {
        if(!Set.of("global","small-text").contains(policy))throw new IllegalArgumentException("Unknown poolPolicy: "+policy);
        if(textHeight<1||textHeight>256||maxWidth<1||maxWidth>256)throw new IllegalArgumentException("Small-text selector outside original 256px page");
        if(!MANAGERS.isEmpty())throw new IllegalStateException("Pool policy cannot change while a font manager is live");
        enabled=on; shareBitmapCells=cells; output=out;
        poolPolicy=policy;smallTextHeight=textHeight;smallTextMaxWidth=maxWidth;
        for(String name:List.of("stitches","specialHits","specialMisses","cellHits","cellMisses","clonedGlyphs","fallbackStitches","ownerAcquire","ownerRelease","duplicateClear","duplicateClose","generationCreate","poolCreate","poolClose","poolCloseFailures","createRollback","applyFailure","errors","underflows"))COUNTERS.putIfAbsent(name,0L);
    }}
    static void count(String key) { COUNTERS.merge(key,1L,Long::sum); }
    static void error(String text) { count("errors"); if(ERRORS.size()==32)ERRORS.removeFirst(); ERRORS.addLast(text); }
    static Backend api() { if(backend==null)backend=new RealBackend(); return backend; }

    static final class Manager {
        final Object manager, textureManager;
        final Generation bootstrap;
        Generation current;
        Manager(Object value) { manager=value; textureManager=api().textureManager(value); bootstrap=new Generation(this,true); }
    }
    static final class Generation {
        final long id=++sequence;
        final Manager manager;
        final boolean bootstrap;
        final Set<Object> owners=Collections.newSetFromMap(new IdentityHashMap<>());
        final Map<CellKey,Object> cells=new HashMap<>();
        final Map<String,Object> specials=new HashMap<>();
        final Map<String,Pool> pools=new LinkedHashMap<>();
        int allocations;
        Generation(Manager manager,boolean bootstrap) { this.manager=manager; this.bootstrap=bootstrap; count("generationCreate"); }
    }
    static final class Pool {
        final String group;
        final int allocation;
        final Object stitcher;
        Pool(String group,int allocation,Object stitcher){this.group=group;this.allocation=allocation;this.stitcher=stitcher;}
    }
    static final class Binding {
        final Manager manager;
        final Generation assigned;
        Generation lease;
        Binding(Manager manager,Generation assigned){this.manager=manager;this.assigned=assigned;}
    }
    static final class Scope {
        final Manager manager;
        final Generation generation;
        final Set<Object> created=Collections.newSetFromMap(new IdentityHashMap<>());
        Scope(Manager manager,Generation generation){this.manager=manager;this.generation=generation;}
    }
    /** Identity image/format, exact source pixel rectangle, fixed pinned uploader. */
    static final class CellKey {
        final Object image,format;
        final int x,y,width,height;
        final boolean colored;
        CellKey(Object image,Object format,int x,int y,int width,int height,boolean colored){
            this.image=Objects.requireNonNull(image);this.format=Objects.requireNonNull(format);
            this.x=x;this.y=y;this.width=width;this.height=height;this.colored=colored;
        }
        public int hashCode(){int h=31*System.identityHashCode(image)+System.identityHashCode(format);h=31*h+x;h=31*h+y;h=31*h+width;h=31*h+height;return 31*h+(colored?1:0);}
        public boolean equals(Object value){return value instanceof CellKey k&&image==k.image&&format==k.format&&x==k.x&&y==k.y&&width==k.width&&height==k.height&&colored==k.colored;}
    }

    static Manager manager(Object value){
        Manager result=MANAGERS.get(value);
        if(result==null){if(CLOSED_MANAGERS.containsKey(value))throw new IllegalStateException("FontManager used after close");result=new Manager(value);MANAGERS.put(value,result);}
        return result;
    }
    static Binding bind(Object source){
        Binding binding=BINDINGS.get(source);
        if(binding==null&&!SCOPES.get().isEmpty()){
            if(CLOSED_SOURCES.containsKey(source))throw new IllegalStateException("GlyphStitcher used after close");
            Scope scope=SCOPES.get().peek();binding=new Binding(scope.manager,scope.generation);
            BINDINGS.put(source,binding);scope.created.add(source);count("ownerBind");
        }
        return binding;
    }
    static Generation acquire(Object source,Binding binding){
        if(binding.lease!=null)return binding.lease;
        Generation generation=binding.assigned;
        if(!generation.owners.add(source))throw new IllegalStateException("Duplicate GPU owner acquire");
        binding.lease=generation;count("ownerAcquire");return generation;
    }
    static String group(CellKey key){
        // Storage-only predicate. Original provider height/ascent/oversample and
        // the SheetGlyphInfo bearings never participate in or change with it.
        // 22 is the observed raw-cell height, not the provider's display height.
        if(poolPolicy.equals("small-text")&&key.height==smallTextHeight&&key.width>0&&key.width<=smallTextMaxWidth)
            return "small-text-h"+smallTextHeight+"-w"+smallTextMaxWidth;
        return "main";
    }
    static Object pool(Generation generation,String group){
        Pool pool=generation.pools.get(group);
        if(pool==null){
            int allocation=++generation.allocations;
            Object stitcher=api().newPool(generation.manager.textureManager,"font_gpu_cache:shared/g"+generation.id+"_"+allocation);
            pool=new Pool(group,allocation,stitcher);generation.pools.put(group,pool);
            count("poolCreate");
        }
        return pool.stitcher;
    }
    static void release(Object source,Binding binding){
        if(binding==null||binding.lease==null){count("duplicateClear");return;}
        Generation generation=binding.lease;binding.lease=null;
        if(!generation.owners.remove(source)){count("underflows");throw new IllegalStateException("GPU lease underflow");}
        count("ownerRelease");
        if(generation.owners.isEmpty())disposePool(generation);
    }
    static void disposePool(Generation generation){
        // Drop NativeImage key references before vanilla closes old providers.
        generation.cells.clear();generation.specials.clear();
        Throwable firstFailure=null;
        for(Pool pool:new ArrayList<>(generation.pools.values())){
            try{
                Object old=pool.stitcher;api().originalClear(old);generation.pools.remove(pool.group);count("poolClose");
                long[] remaining=api().usage(old);
                Map<String,Object> closed=new LinkedHashMap<>();closed.put("id",generation.id);closed.put("allocation",pool.allocation);closed.put("poolGroup",pool.group);closed.put("managerIdentity",System.identityHashCode(generation.manager.manager));closed.put("bootstrap",generation.bootstrap);closed.put("owners",generation.owners.size());closed.put("sharedPages",remaining[0]);closed.put("sharedTextureBytes",remaining[1]);closed.put("cellEntries",generation.cells.size());closed.put("closed",true);closed.put("timeMillis",System.currentTimeMillis());
                if(HISTORY.size()==64)HISTORY.removeFirst();HISTORY.addLast(closed);
            }catch(Throwable failure){
                // A failing group must not prevent the remaining independent
                // owners from being closed. Keep its entry for later cleanup,
                // expose the failure, and propagate it after every attempt.
                count("poolCloseFailures");error("Pool close "+pool.group+": "+failure);firstFailure=appendFailure(firstFailure,failure);
            }
        }
        if(firstFailure!=null)throw propagate(firstFailure);
    }
    static void rollbackSources(Collection<Object> sources){
        for(Object source:new ArrayList<>(sources))try{closeStitcher(source);count("createRollback");}catch(Throwable failure){error("Rollback: "+failure);}
    }

    public static Object createFontSet(Object value,Object id,Object providers,Object options){ synchronized(LOCK){
        api().assertRenderThread();Manager manager=manager(value);
        Scope scope=new Scope(manager,manager.current==null?manager.bootstrap:manager.current);
        Deque<Scope> scopes=SCOPES.get();scopes.push(scope);
        try{return api().originalCreate(value,id,providers,options);}
        catch(Throwable failure){rollbackSources(scope.created);throw propagate(failure);}
        finally{scopes.pop();if(scopes.isEmpty())SCOPES.remove();}
    }}
    public static void apply(Object value,Object preparation,Object barrier){ synchronized(LOCK){
        api().assertRenderThread();Manager manager=manager(value);
        Generation generation=new Generation(manager,false);manager.current=generation;
        try{api().originalApply(value,preparation,barrier);}
        catch(Throwable failure){
            count("applyFailure");
            // Vanilla may have published some new FontSets before throwing. They
            // still own their GPU storage until vanilla's next close/reload.
            Set<Object> published=api().publishedStitchers(value);
            List<Object> orphaned=new ArrayList<>();
            BINDINGS.forEach((source,binding)->{if(binding.manager==manager&&binding.assigned==generation&&!published.contains(source))orphaned.add(source);});
            rollbackSources(orphaned);throw propagate(failure);
        }
    }}
    public static Object stitch(Object source,Object info,Object sheet){ synchronized(LOCK){
        api().assertRenderThread();count("stitches");
        if(CLOSED_SOURCES.containsKey(source))throw new IllegalStateException("GlyphStitcher used after close");
        Binding binding=bind(source);
        String special=enabled?api().special(info,sheet):null;
        CellKey key=enabled&&shareBitmapCells&&special==null?api().bitmapKey(sheet):null;
        if(!enabled||binding==null||(special==null&&key==null)){
            count("fallbackStitches");return api().originalStitch(source,info,sheet);
        }
        boolean fresh=binding.lease==null;Generation generation=acquire(source,binding);
        try{
            if(special!=null){
                Object baked=generation.specials.get(special);
                if(baked!=null){count("specialHits");return baked;}
                baked=api().originalStitch(pool(generation,"main"),info,sheet);
                if(baked!=null){generation.specials.put(special,baked);count("specialMisses");}
                else if(fresh)release(source,binding);
                return baked;
            }
            Object stored=generation.cells.get(key);
            if(stored==null){
                Object baked=api().originalStitch(pool(generation,group(key)),info,sheet);
                if(baked==null){if(fresh)release(source,binding);return null;}
                stored=api().storage(baked);generation.cells.put(key,stored);count("cellMisses");
            }else count("cellHits");
            // Even the first caller gets its own info and geometry; only GPU
            // texture/render types/UV allocation are stored in the shared map.
            Object result=api().cloneGlyph(stored,info,sheet);count("clonedGlyphs");return result;
        }catch(Throwable failure){if(fresh)release(source,binding);throw propagate(failure);}
    }}
    public static void clearStitcher(Object source){ synchronized(LOCK){
        api().assertRenderThread();Throwable firstFailure=null;
        try{release(source,BINDINGS.get(source));}catch(Throwable failure){firstFailure=failure;}
        // Shared cleanup failure must not skip the source's own fallback pages.
        try{api().originalClear(source);}catch(Throwable failure){firstFailure=appendFailure(firstFailure,failure);}
        if(firstFailure!=null)throw propagate(firstFailure);
    }}
    public static void closeStitcher(Object source){ synchronized(LOCK){
        api().assertRenderThread();
        if(CLOSED_SOURCES.put(source,Boolean.TRUE)!=null){count("duplicateClose");return;}
        try{api().originalClose(source);}finally{Binding binding=BINDINGS.remove(source);release(source,binding);count("ownerUnbind");}
    }}
    public static void closeManager(Object value){ synchronized(LOCK){
        api().assertRenderThread();
        if(CLOSED_MANAGERS.put(value,Boolean.TRUE)!=null){count("duplicateManagerClose");return;}
        Manager manager=MANAGERS.get(value);
        try{api().originalManagerClose(value);}finally{
            if(manager!=null){List<Object> remaining=new ArrayList<>();BINDINGS.forEach((source,binding)->{if(binding.manager==manager)remaining.add(source);});rollbackSources(remaining);disposePool(manager.bootstrap);if(manager.current!=null)disposePool(manager.current);}
            MANAGERS.remove(value);count("managerClose");
        }
    }}

    public static String snapshotJson(){synchronized(LOCK){return json(snapshot());}}
    static Map<String,Object> snapshot(){
        List<Map<String,Object>> generations=new ArrayList<>();
        Set<Generation> unique=Collections.newSetFromMap(new IdentityHashMap<>());
        for(Manager manager:MANAGERS.values()){unique.add(manager.bootstrap);if(manager.current!=null)unique.add(manager.current);}
        for(Binding binding:BINDINGS.values())unique.add(binding.assigned);
        long pages=0,bytes=0,owners=0,live=0,cells=0;
        for(Generation generation:unique){
            long[] usage=new long[]{0,0};List<Map<String,Object>> groups=new ArrayList<>();
            for(Pool pool:generation.pools.values()){
                long[] poolUsage=api().usage(pool.stitcher);usage[0]+=poolUsage[0];usage[1]+=poolUsage[1];
                Map<String,Object> group=new LinkedHashMap<>();group.put("group",pool.group);group.put("allocation",pool.allocation);group.put("textureBase","font_gpu_cache:shared/g"+generation.id+"_"+pool.allocation);group.put("sharedPages",poolUsage[0]);group.put("sharedTextureBytes",poolUsage[1]);groups.add(group);
            }
            if(usage[0]>0||!generation.owners.isEmpty())live++;
            pages+=usage[0];bytes+=usage[1];owners+=generation.owners.size();cells+=generation.cells.size();
            Map<String,Object> row=new LinkedHashMap<>();row.put("id",generation.id);row.put("managerIdentity",System.identityHashCode(generation.manager.manager));row.put("bootstrap",generation.bootstrap);row.put("owners",generation.owners.size());row.put("sharedPages",usage[0]);row.put("sharedTextureBytes",usage[1]);row.put("cellEntries",generation.cells.size());row.put("specialGlyphs",generation.specials.size());row.put("closed",generation.pools.isEmpty()&&generation.owners.isEmpty());row.put("poolGroups",groups);generations.add(row);
        }
        generations.sort(Comparator.comparingLong(row->((Number)row.get("id")).longValue()));
        Map<String,Object> result=new LinkedHashMap<>();result.put("schema",1);result.put("enabled",enabled);result.put("shareBitmapCells",shareBitmapCells);result.put("poolPolicy",poolPolicy);result.put("smallTextRawHeight",smallTextHeight);result.put("smallTextMaxRawWidth",smallTextMaxWidth);result.put("activeManagers",MANAGERS.size());result.put("activeOwnerBindings",BINDINGS.size());result.put("activeLeases",owners);result.put("liveGenerations",live);result.put("liveSharedPages",pages);result.put("liveSharedTextureBytes",bytes);result.put("cellEntries",cells);result.put("counters",new TreeMap<>(COUNTERS));result.put("errors",new ArrayList<>(ERRORS));result.put("generations",generations);result.put("closedPools",new ArrayList<>(HISTORY));return result;
    }
    public static void mark(String label){
        Map<String,Object> event;synchronized(LOCK){event=new LinkedHashMap<>(snapshot());event.put("label",label);event.put("timeMillis",System.currentTimeMillis());}
        if(output==null)return;
        // Unique temporary files and serialized append prevent concurrent audit
        // snapshots from corrupting the latest JSON/checkpoint journal.
        synchronized(FontGpuCache.class){try{
            Files.createDirectories(output);String data=json(event)+"\n";
            Path temp=Files.createTempFile(output,"cache-stats-",".tmp");Files.writeString(temp,data);
            try{Files.move(temp,output.resolve("cache-stats.json"),StandardCopyOption.REPLACE_EXISTING,StandardCopyOption.ATOMIC_MOVE);}catch(AtomicMoveNotSupportedException ignored){Files.move(temp,output.resolve("cache-stats.json"),StandardCopyOption.REPLACE_EXISTING);}
            Files.writeString(output.resolve("cache-events.jsonl"),data,StandardOpenOption.CREATE,StandardOpenOption.APPEND);
        }catch(IOException failure){synchronized(LOCK){error("Statistics: "+failure);}}}
    }
    static RuntimeException propagate(Throwable failure){if(failure instanceof Error error)throw error;return failure instanceof RuntimeException runtime?runtime:new RuntimeException(failure);}
    static Throwable appendFailure(Throwable first,Throwable next){if(first==null)return next;if(first!=next)first.addSuppressed(next);return first;}
    static String json(Object value){
        if(value==null)return "null";if(value instanceof Number||value instanceof Boolean)return value.toString();
        if(value instanceof Map<?,?> map){StringJoiner out=new StringJoiner(",","{","}");map.forEach((k,v)->out.add(json(k.toString())+":"+json(v)));return out.toString();}
        if(value instanceof Iterable<?> list){StringJoiner out=new StringJoiner(",","[","]");for(Object item:list)out.add(json(item));return out.toString();}
        String text=value.toString();StringBuilder out=new StringBuilder("\"");for(char c:text.toCharArray()){if(c=='"'||c=='\\')out.append('\\').append(c);else if(c=='\n')out.append("\\n");else if(c=='\r')out.append("\\r");else if(c=='\t')out.append("\\t");else if(c<32)out.append(String.format("\\u%04x",(int)c));else out.append(c);}return out.append('"').toString();
    }

    interface Backend {
        void assertRenderThread();Object textureManager(Object manager);Object newPool(Object textureManager,String id);
        Object originalCreate(Object manager,Object id,Object providers,Object options);
        void originalApply(Object manager,Object preparation,Object barrier);void originalManagerClose(Object manager);
        Object originalStitch(Object source,Object info,Object sheet);void originalClear(Object source);void originalClose(Object source);
        Set<Object> publishedStitchers(Object manager);String special(Object info,Object sheet);CellKey bitmapKey(Object sheet);
        Object storage(Object baked);Object cloneGlyph(Object stored,Object info,Object sheet);long[] usage(Object pool);
    }

    static final class RealBackend implements Backend {
        final Class<?> stitcher=type("gnu"),manager=type("gnp"),sheet=type("fwo"),info=type("fwp"),bitmap=type("goh$b"),bitmapSheet=type("goh$b$1"),special=type("goe"),specialSheet=type("goe$1");
        final Method assertThread=method(type("com.mojang.blaze3d.systems.RenderSystem"),"assertOnRenderThread");
        final Method stitch=method(stitcher,"barkanGpuOriginalStitch",info,sheet),clear=method(stitcher,"barkanGpuOriginalClear"),close=method(stitcher,"barkanGpuOriginalClose");
        final Method create=method(manager,"barkanGpuOriginalCreate",type("amo"),List.class,Set.class),apply=method(manager,"barkanGpuOriginalApply",type("gnp$e"),type("bzm")),managerClose=method(manager,"barkanGpuOriginalClose");
        final Method identifier=method(type("amo"),"a",String.class),imageFormat=method(type("fyh"),"c"),width=method(sheet,"a"),height=method(sheet,"b"),colored=method(sheet,"c");
        final Method[] bearings={method(sheet,"e"),method(sheet,"f"),method(sheet,"g"),method(sheet,"h")};
        final Constructor<?> newStitcher=constructor(stitcher,type("ilr"),type("amo"));
        final Constructor<?> newGlyph=constructor(type("gob"),info,type("gnt"),type("com.mojang.blaze3d.textures.GpuTextureView"),float.class,float.class,float.class,float.class,float.class,float.class,float.class,float.class);
        final Field textureManager=field(manager,"i"),fontSets=field(manager,"h"),missingFont=field(manager,"f"),fontStitcher=field(type("gnr"),"c"),textures=field(stitcher,"c");
        final Field enclosing=field(bitmapSheet,"a"),specialEnclosing=field(specialSheet,"a");
        final Field image=field(bitmap,"b"),srcX=field(bitmap,"c"),srcY=field(bitmap,"d"),srcW=field(bitmap,"e"),srcH=field(bitmap,"f");
        final Field[] storedFields={field(type("gob"),"c"),field(type("gob"),"d"),field(type("gob"),"e"),field(type("gob"),"f"),field(type("gob"),"g"),field(type("gob"),"h")};
        final Field pageColored=field(type("gns"),"f");
        public void assertRenderThread(){call(assertThread,null);}
        public Object textureManager(Object value){return get(textureManager,value);}
        public Object newPool(Object tm,String id){return construct(newStitcher,tm,call(identifier,null,id));}
        public Object originalCreate(Object value,Object id,Object providers,Object options){return call(create,value,id,providers,options);}
        public void originalApply(Object value,Object preparation,Object barrier){call(apply,value,preparation,barrier);}
        public void originalManagerClose(Object value){call(managerClose,value);}
        public Object originalStitch(Object value,Object i,Object s){return call(stitch,value,i,s);}
        public void originalClear(Object value){call(clear,value);}
        public void originalClose(Object value){call(close,value);}
        public Set<Object> publishedStitchers(Object value){
            Set<Object> result=Collections.newSetFromMap(new IdentityHashMap<>());
            for(Object font:((Map<?,?>)get(fontSets,value)).values())result.add(get(fontStitcher,font));
            Object missing=get(missingFont,value);if(missing!=null)result.add(get(fontStitcher,missing));return result;
        }
        public String special(Object i,Object s){
            if(i.getClass()!=special||s.getClass()!=specialSheet||get(specialEnclosing,s)!=i)return null;
            if(((Number)call(width,s)).intValue()!=5||((Number)call(height,s)).intValue()!=8||!Boolean.TRUE.equals(call(colored,s)))throw new IllegalStateException("Unexpected pinned special glyph dimensions");
            return ((Enum<?>)i).name();
        }
        public CellKey bitmapKey(Object value){
            if(value.getClass()!=bitmapSheet)return null;
            Object glyph=get(enclosing,value);if(glyph.getClass()!=bitmap)throw new IllegalStateException("Unexpected bitmap enclosing class");
            int x=(Integer)get(srcX,glyph),y=(Integer)get(srcY,glyph),w=(Integer)get(srcW,glyph),h=(Integer)get(srcH,glyph);
            if(w!=((Number)call(width,value)).intValue()||h!=((Number)call(height,value)).intValue())throw new IllegalStateException("Bitmap upload dimensions disagree");
            Object nativeImage=get(image,glyph);return new CellKey(nativeImage,call(imageFormat,nativeImage),x,y,w,h,(Boolean)call(colored,value));
        }
        public Object storage(Object baked){Object[] result=new Object[6];for(int i=0;i<6;i++)result[i]=get(storedFields[i],baked);return result;}
        public Object cloneGlyph(Object saved,Object currentInfo,Object currentSheet){
            Object[] stored=(Object[])saved;Object[] args=new Object[11];args[0]=currentInfo;
            System.arraycopy(stored,0,args,1,6);for(int i=0;i<4;i++)args[i+7]=call(bearings[i],currentSheet);
            return construct(newGlyph,args);
        }
        public long[] usage(Object value){
            long pages=0,bytes=0;for(Object page:(List<?>)get(textures,value)){pages++;bytes+=256L*256L*((Boolean)get(pageColored,page)?4L:1L);}return new long[]{pages,bytes};
        }
    }
    static Class<?> type(String name){try{return Class.forName(name,false,ClassLoader.getSystemClassLoader());}catch(ReflectiveOperationException failure){throw new IllegalStateException(failure);}}
    static Field field(Class<?> type,String name){try{Field f=type.getDeclaredField(name);f.setAccessible(true);return f;}catch(ReflectiveOperationException failure){throw new IllegalStateException(failure);}}
    static Method method(Class<?> type,String name,Class<?>...args){try{Method m=type.getDeclaredMethod(name,args);m.setAccessible(true);return m;}catch(ReflectiveOperationException failure){throw new IllegalStateException(failure);}}
    static Constructor<?> constructor(Class<?> type,Class<?>...args){try{Constructor<?> c=type.getDeclaredConstructor(args);c.setAccessible(true);return c;}catch(ReflectiveOperationException failure){throw new IllegalStateException(failure);}}
    static Object get(Field field,Object value){try{return field.get(value);}catch(ReflectiveOperationException failure){throw new IllegalStateException(failure);}}
    static Object call(Method method,Object value,Object...args){try{return method.invoke(value,args);}catch(InvocationTargetException failure){throw propagate(failure.getCause());}catch(ReflectiveOperationException failure){throw new IllegalStateException(failure);}}
    static Object construct(Constructor<?> constructor,Object...args){try{return constructor.newInstance(args);}catch(InvocationTargetException failure){throw propagate(failure.getCause());}catch(ReflectiveOperationException failure){throw new IllegalStateException(failure);}}
}
