package benchmark.fontcache;

import java.io.*;
import java.lang.ref.*;
import java.lang.reflect.*;
import java.nio.*;
import java.nio.file.*;
import java.security.*;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;

/** Pixel-only ownership experiment. No Minecraft class is linked at agent startup. */
public final class FontImageCache {
    interface NativeOps {
        Object read(Object format, InputStream stream) throws Throwable;
        long bytes(Object image) throws Throwable;
        long pointer(Object image) throws Throwable;
        String digest(Object image) throws Throwable;
        void close(Object image) throws Throwable;
    }
    static final Object LOCK = new Object();
    static final ReferenceQueue<Object> QUEUE = new ReferenceQueue<>();
    static final Map<WeakIdentity,Generation> MANAGERS = new HashMap<>();
    static final List<Generation> HISTORY = new ArrayList<>();
    static final IdentityHashMap<Object,Entry> OWNERS = new IdentityHashMap<>();
    static final IdentityHashMap<Object,Entry> IMAGES = new IdentityHashMap<>();
    static final ThreadLocal<ArrayDeque<Context>> CONTEXTS = ThreadLocal.withInitial(ArrayDeque::new);
    static final LinkedHashMap<String,Long> COUNTERS = new LinkedHashMap<>();
    static final ArrayDeque<String> ERRORS = new ArrayDeque<>();
    static NativeOps nativeOps = new ReflectiveOps();
    static boolean enabled = true, verifyPixels;
    static Path output;
    static long nextGeneration;
    static { for(String name:List.of("acquires","decodeCalls","decodesSucceeded","decodeFailures","cacheHits","releases","rollbacks","physicalCloses","decodeFailureCleanupCloses","providerCloseCalls","doubleCloseCalls","untrackedPhysicalCloses","underflows","errors","loadBegins","loadAborts","providersCommitted","pixelDigestMismatches","generationsCreated","providerClassTransformed","definitionClassTransformed"))COUNTERS.put(name,0L); }

    static final class WeakIdentity extends WeakReference<Object> {
        final int hash;
        WeakIdentity(Object value, ReferenceQueue<Object> queue) { super(value,queue); hash=System.identityHashCode(value); }
        public int hashCode(){return hash;}
        public boolean equals(Object other){if(this==other)return true;Object a=get();return a!=null && other instanceof WeakIdentity w && a==w.get();}
    }
    static final class Key {
        final String resource; final Object format;
        Key(String resource,Object format){this.resource=resource;this.format=format;}
        public int hashCode(){return 31*resource.hashCode()+System.identityHashCode(format);}
        public boolean equals(Object o){return o instanceof Key k && resource.equals(k.resource) && format==k.format;}
    }
    static final class Generation {
        final long id;final int identity;
        final Map<Key,Entry> cache=new HashMap<>();
        final Set<Entry> entries=Collections.newSetFromMap(new IdentityHashMap<>());
        long acquires,decodes,hits,releases,rollbacks,closes;
        Generation(Object manager){id=++nextGeneration;identity=System.identityHashCode(manager);}
    }
    static final class Entry {
        final Generation generation;final Key key;final NativeOps ops;final boolean shared;
        final CompletableFuture<Object> ready=new CompletableFuture<>();
        long refs=1,bytes,pointer;Object image;String digest;boolean failed,freed;
        Entry(Generation generation,Key key,boolean shared){this.generation=generation;this.key=key;this.shared=shared;ops=nativeOps;}
    }
    static final class Context {
        final Object manager;Entry lease;
        Context(Object manager){this.manager=manager;}
    }

    static void count(String name){COUNTERS.merge(name,1L,Long::sum);}
    static void error(String text){count("errors");if(ERRORS.size()==32)ERRORS.removeFirst();ERRORS.addLast(text);}
    static void purge(){for(Reference<?> key;(key=QUEUE.poll())!=null;)MANAGERS.remove(key);while(HISTORY.size()>64 && HISTORY.getFirst().entries.isEmpty())HISTORY.removeFirst();}
    static Generation generation(Object manager){
        purge();WeakIdentity probe=new WeakIdentity(manager,null);Generation found=MANAGERS.get(probe);
        if(found==null){found=new Generation(manager);MANAGERS.put(new WeakIdentity(manager,QUEUE),found);HISTORY.add(found);count("generationsCreated");event("generation_created",Map.of("generation",found.id,"managerIdentity",found.identity));}
        else if(!HISTORY.contains(found))HISTORY.add(found);
        return found;
    }

    public static void configure(boolean on,boolean verify,Path out){synchronized(LOCK){enabled=on;verifyPixels=verify;output=out;}}
    public static void begin(Object definition,Object manager){CONTEXTS.get().push(new Context(Objects.requireNonNull(manager)));synchronized(LOCK){count("loadBegins");}}

    /** Replacement for the one NativeImage.read(Format, InputStream) call. */
    public static Object read(Object format,InputStream stream,Object manager,Object identifier) throws Throwable {
        Context context=CONTEXTS.get().peek();
        if(context==null || context.manager!=manager || context.lease!=null)throw new IllegalStateException("Bitmap load transaction mismatch");
        Entry entry;boolean creator;
        synchronized(LOCK){
            Generation g=generation(manager);Key key=new Key(identifier.toString(),format);
            entry=enabled?g.cache.get(key):null;creator=entry==null;
            if(creator){entry=new Entry(g,key,enabled);g.entries.add(entry);if(enabled)g.cache.put(key,entry);g.decodes++;count("decodeCalls");}
            else{entry.refs++;g.hits++;count("cacheHits");}
            g.acquires++;count("acquires");context.lease=entry;
        }
        if(creator){
            Object image=null;boolean mayCloseDecodedImage=true;
            try {
                image=entry.ops.read(format,stream);
                long bytes=entry.ops.bytes(image),pointer=entry.ops.pointer(image);
                if(bytes<0 || pointer==0)throw new IllegalStateException("Decoded bitmap has invalid native allocation");
                String digest=verifyPixels?entry.ops.digest(image):null;
                synchronized(LOCK){
                    if(IMAGES.containsKey(image)){mayCloseDecodedImage=false;throw new IllegalStateException("Decoder returned already owned NativeImage");}
                    entry.image=image;entry.bytes=bytes;entry.pointer=pointer;entry.digest=digest;IMAGES.put(image,entry);count("decodesSucceeded");
                }
                entry.ready.complete(image);
                return image;
            } catch(Throwable failure){
                // Metadata reflection/digest failures after a successful read
                // still own the allocation and must close it before publishing.
                if(image!=null && mayCloseDecodedImage){try{entry.ops.close(image);synchronized(LOCK){count("physicalCloses");count("decodeFailureCleanupCloses");}}catch(Throwable close){failure.addSuppressed(close);}}
                synchronized(LOCK){entry.failed=true;if(entry.generation.cache.get(entry.key)==entry)entry.generation.cache.remove(entry.key);count("decodeFailures");}
                entry.ready.completeExceptionally(failure);
                throw failure;
            }
        }
        try{return entry.ready.join();}
        catch(CompletionException failure){throw failure.getCause();}
        finally{closeQuietly(stream);} // NativeImage.read also performs this first quiet close.
    }
    static void closeQuietly(InputStream stream){if(stream!=null)try{stream.close();}catch(IOException ignored){}}

    /** The original outer InputStream.close has completed before this hook. */
    public static void commit(Object provider){
        ArrayDeque<Context> stack=CONTEXTS.get();Context context=stack.peek();
        if(context==null || context.lease==null)throw new IllegalStateException("Bitmap commit without lease");
        synchronized(LOCK){if(OWNERS.containsKey(provider))throw new IllegalStateException("Bitmap provider already owns a lease");OWNERS.put(provider,context.lease);count("providersCommitted");}
        stack.pop();if(stack.isEmpty())CONTEXTS.remove();
    }
    public static void abort(Throwable cause){
        ArrayDeque<Context> stack=CONTEXTS.get();Context context=stack.poll();if(stack.isEmpty())CONTEXTS.remove();
        synchronized(LOCK){count("loadAborts");}
        if(context!=null && context.lease!=null){synchronized(LOCK){context.lease.generation.rollbacks++;count("rollbacks");}release(context.lease);}
    }
    public static void doubleClose(){synchronized(LOCK){count("doubleCloseCalls");}}
    /** goh.close has a synchronized per-provider injected closed flag. */
    public static void closeProvider(Object provider,Object image){
        Entry entry;
        synchronized(LOCK){entry=OWNERS.remove(provider);count("providerCloseCalls");
            if(entry==null && IMAGES.containsKey(image)){error("Unowned provider attempted to close a shared image; preserved live allocation");return;}}
        if(entry!=null){if(entry.image!=image){synchronized(LOCK){error("Provider image/lease identity mismatch");}}release(entry);}
        else {try{nativeOps.close(image);synchronized(LOCK){count("untrackedPhysicalCloses");}}catch(Throwable failure){synchronized(LOCK){error("Untracked close: "+failure);}}}
    }
    static void release(Entry entry){
        Object close=null;
        synchronized(LOCK){
            if(entry.refs<=0){count("underflows");error("Refcount underflow");return;}
            entry.refs--;entry.generation.releases++;count("releases");
            if(entry.refs==0){
                if(entry.generation.cache.get(entry.key)==entry)entry.generation.cache.remove(entry.key);
                entry.generation.entries.remove(entry);
                if(entry.image!=null){IMAGES.remove(entry.image);close=entry.image;entry.freed=true;entry.generation.closes++;}
                if(entry.generation.entries.isEmpty())event("generation_inactive",Map.of("generation",entry.generation.id));
            }
        }
        if(close!=null){
            try{if(verifyPixels && entry.digest!=null && !entry.digest.equals(entry.ops.digest(close)))synchronized(LOCK){count("pixelDigestMismatches");error("Bitmap pixel digest changed: "+entry.key.resource);}}
            catch(Throwable failure){synchronized(LOCK){error("Final pixel audit: "+failure);}}
            finally{try{entry.ops.close(close);synchronized(LOCK){count("physicalCloses");}}catch(Throwable failure){synchronized(LOCK){error("Physical close: "+failure);}}}
        }
    }

    public static String snapshotJson(){
        String json;
        synchronized(LOCK){
            purge();List<Object> generations=new ArrayList<>();long totalBytes=0,totalRefs=0,entries=0,weighted=0,pending=0;
            for(Generation g:HISTORY){long bytes=0,refs=0,live=0,waiting=0;
                for(Entry e:g.entries){refs+=e.refs;if(e.image!=null){bytes+=e.bytes;live++;weighted+=e.bytes*e.refs;}else waiting++;}
                totalBytes+=bytes;totalRefs+=refs;entries+=live;pending+=waiting;
                generations.add(map("id",g.id,"managerIdentity",g.identity,"liveEntries",live,"liveBytes",bytes,"liveRefs",refs,"pendingEntries",waiting,
                        "acquires",g.acquires,"decodes",g.decodes,"hits",g.hits,"releases",g.releases,"rollbacks",g.rollbacks,"physicalCloses",g.closes));
            }
            json=json(map("schema","font-image-cache-v1","at",Instant.now().toString(),"enabled",enabled,"verifyPixels",verifyPixels,
                    "liveEntries",entries,"liveBytes",totalBytes,"liveRefs",totalRefs,"liveWeightedBytes",weighted,"pendingEntries",pending,
                    "liveOwnedProviders",OWNERS.size(),"liveManagerKeys",MANAGERS.size(),"generations",generations,"counters",new LinkedHashMap<>(COUNTERS),"errors",new ArrayList<>(ERRORS)));
        }
        writeSnapshot(json);return json;
    }
    /** Optional integrity phase: direct native ByteBuffer views, no pixel-array copy. */
    public static String auditPixelsJson(){synchronized(LOCK){
        List<Object> rows=new ArrayList<>();long mismatches=0;
        for(Entry entry:IMAGES.values())try{String digest=entry.ops.digest(entry.image);Boolean match=entry.digest==null?null:entry.digest.equals(digest);if(Boolean.FALSE.equals(match))mismatches++;
            rows.add(map("generation",entry.generation.id,"resource",entry.key.resource,"format",String.valueOf(entry.key.format),"bytes",entry.bytes,"pointer",entry.pointer,"refs",entry.refs,"sha256",digest,"matchesDecodeDigest",match));
        }catch(Throwable failure){error("Pixel audit: "+failure);}
        return json(map("schema","font-image-cache-pixels-v1","pixelCopies",0,"mismatches",mismatches,"entries",rows));
    }}
    public static void mark(String label){synchronized(LOCK){event("mark",Map.of("label",label));}snapshotJson();}
    static LinkedHashMap<String,Object> map(Object... values){LinkedHashMap<String,Object> map=new LinkedHashMap<>();for(int i=0;i<values.length;i+=2)map.put(String.valueOf(values[i]),values[i+1]);return map;}
    static String json(Object o){
        if(o==null)return "null";if(o instanceof Number || o instanceof Boolean)return o.toString();
        if(o instanceof Map<?,?> m){StringJoiner s=new StringJoiner(",","{","}");m.forEach((k,v)->s.add(json(k.toString())+":"+json(v)));return s.toString();}
        if(o instanceof Iterable<?> a){StringJoiner s=new StringJoiner(",","[","]");a.forEach(v->s.add(json(v)));return s.toString();}
        String s=o.toString();StringBuilder b=new StringBuilder("\"");for(int i=0;i<s.length();i++){char c=s.charAt(i);if(c=='"'||c=='\\')b.append('\\').append(c);else if(c=='\n')b.append("\\n");else if(c=='\r')b.append("\\r");else if(c=='\t')b.append("\\t");else if(c<32)b.append(String.format("\\u%04x",(int)c));else b.append(c);}return b.append('"').toString();
    }
    static void event(String event,Map<String,Object> details){if(output==null)return;try{Files.createDirectories(output);Files.writeString(output.resolve("cache-events.jsonl"),json(map("at",Instant.now().toString(),"event",event,"details",details))+"\n",StandardOpenOption.CREATE,StandardOpenOption.APPEND);}catch(IOException failure){error("Event write: "+failure);}}
    static void writeSnapshot(String json){Path out=output;if(out==null)return;try{Files.createDirectories(out);Path tmp=out.resolve("cache-stats.json.tmp."+Thread.currentThread().threadId());Files.writeString(tmp,json+"\n");Files.move(tmp,out.resolve("cache-stats.json"),StandardCopyOption.REPLACE_EXISTING,StandardCopyOption.ATOMIC_MOVE);}catch(IOException failure){synchronized(LOCK){error("Snapshot write: "+failure);}}}

    static final class ReflectiveOps implements NativeOps {
        final Map<Class<?>,Access> access=new ConcurrentHashMap<>();
        Access access(Object image){return access.computeIfAbsent(image.getClass(),Access::new);}
        public Object read(Object format,InputStream stream)throws Throwable{
            ClassLoader loader=format.getClass().getClassLoader();Class<?> image=Class.forName("fyh",false,loader);
            try{return image.getMethod("a",format.getClass(),InputStream.class).invoke(null,format,stream);}catch(InvocationTargetException failure){throw failure.getCause();}
        }
        public long bytes(Object image)throws Throwable{return access(image).size.getLong(image);}
        public long pointer(Object image)throws Throwable{return ((Number)access(image).pointer.invoke(image)).longValue();}
        public void close(Object image)throws Throwable{try{access(image).close.invoke(image);}catch(InvocationTargetException failure){throw failure.getCause();}}
        public String digest(Object image)throws Throwable{
            long size=bytes(image),pointer=pointer(image);Class<?> memory=Class.forName("org.lwjgl.system.MemoryUtil",false,image.getClass().getClassLoader());Method view=memory.getMethod("memByteBuffer",long.class,int.class);
            MessageDigest digest=MessageDigest.getInstance("SHA-256");
            for(long offset=0;offset<size;){int length=(int)Math.min(1<<20,size-offset);ByteBuffer buffer=(ByteBuffer)view.invoke(null,pointer+offset,length);digest.update(buffer);offset+=length;}
            return HexFormat.of().formatHex(digest.digest());
        }
    }
    static final class Access {
        final Field size;final Method pointer,close;
        Access(Class<?> type){try{size=type.getDeclaredField("i");size.setAccessible(true);pointer=type.getMethod("h");close=type.getMethod("close");}catch(Exception failure){throw new IllegalStateException(failure);}}
    }
}
