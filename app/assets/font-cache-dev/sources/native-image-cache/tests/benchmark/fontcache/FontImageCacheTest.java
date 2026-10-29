package benchmark.fontcache;

import java.io.*;
import java.lang.ref.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

/** Bounded headless ownership tests. Fake pixel allocations are 4 bytes each. */
public final class FontImageCacheTest {
    static int assertions,tests;
    static void check(boolean condition,String message){assertions++;if(!condition)throw new AssertionError(message);}
    static final class Image {
        static final AtomicLong pointers=new AtomicLong(100);
        final byte[] pixels={1,2,3,4};long pointer=pointers.incrementAndGet();int closes;
    }
    static final class Ops implements FontImageCache.NativeOps {
        final AtomicInteger reads=new AtomicInteger(),closes=new AtomicInteger();
        final List<Image> images=Collections.synchronizedList(new ArrayList<>());
        volatile boolean failRead,failMetadata,failDigest;
        public Object read(Object format,InputStream stream)throws Throwable{
            reads.incrementAndGet();try{stream.readAllBytes();if(failRead)throw new IOException("decode failure");Image image=new Image();images.add(image);return image;}finally{FontImageCache.closeQuietly(stream);}
        }
        public long bytes(Object image){if(failMetadata)throw new IllegalStateException("metadata failure");return 4;}
        public long pointer(Object image){return ((Image)image).pointer;}
        public String digest(Object image)throws Exception{if(failDigest)throw new IOException("digest failure");return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(((Image)image).pixels));}
        public void close(Object value){Image image=(Image)value;if(image.pointer==0)throw new AssertionError("double native free");image.pointer=0;image.closes++;closes.incrementAndGet();}
    }
    static Ops reset(boolean enabled){
        synchronized(FontImageCache.LOCK){
            check(FontImageCache.OWNERS.isEmpty(),"prior provider leak");check(FontImageCache.IMAGES.isEmpty(),"prior native image leak");
            for(var g:FontImageCache.HISTORY)check(g.entries.isEmpty(),"prior pending ref leak");
            FontImageCache.MANAGERS.clear();FontImageCache.HISTORY.clear();FontImageCache.ERRORS.clear();FontImageCache.COUNTERS.replaceAll((k,v)->0L);FontImageCache.CONTEXTS.remove();FontImageCache.nextGeneration=0;
            Ops ops=new Ops();FontImageCache.nativeOps=ops;FontImageCache.configure(enabled,false,null);tests++;return ops;
        }
    }
    static Object load(Object manager,String resource,Object format)throws Throwable{
        Object owner=new Object();FontImageCache.begin(new Object(),manager);
        try{FontImageCache.read(format,new ByteArrayInputStream(new byte[]{7,8}),manager,resource);FontImageCache.commit(owner);return owner;}
        catch(Throwable failure){FontImageCache.abort(failure);throw failure;}
    }
    static Image image(Object owner){synchronized(FontImageCache.LOCK){return (Image)FontImageCache.OWNERS.get(owner).image;}}
    static void close(Object owner){FontImageCache.closeProvider(owner,image(owner));}
    static long counter(String name){synchronized(FontImageCache.LOCK){return FontImageCache.COUNTERS.getOrDefault(name,0L);}}
    static void noLeaks(){String json=FontImageCache.snapshotJson();check(json.contains("\"liveEntries\":0"),"live entry leak "+json);check(json.contains("\"liveRefs\":0"),"live ref leak "+json);check(counter("underflows")==0,"underflow");}

    public static void main(String[] args)throws Throwable{
        Object format=new Object(),manager=new Object();Ops ops=reset(true);
        Object a=load(manager,"textures/a.png",format),b=load(manager,"textures/a.png",format);Image shared=image(a);
        check(shared==image(b)&&ops.reads.get()==1,"same PNG should decode once");close(a);check(shared.pointer!=0,"first provider prematurely freed shared image");close(b);check(shared.pointer==0&&ops.closes.get()==1,"last owner must physically close once");noLeaks();
        Object c=load(manager,"textures/a.png",format);check(image(c)!=shared,"freed allocation reused as cache entry");close(c);noLeaks();

        ops=reset(false);a=load(manager,"textures/a.png",format);b=load(manager,"textures/a.png",format);check(image(a)!=image(b)&&ops.reads.get()==2,"OFF must independently decode");Image second=image(b);close(a);check(second.pointer!=0,"OFF close affected independent image");close(b);noLeaks();

        ops=reset(true);Object equalA=new String("equal"),equalB=new String("equal");a=load(equalA,"textures/a.png",format);b=load(equalB,"textures/a.png",format);check(image(a)!=image(b)&&ops.reads.get()==2,"equal but nonidentical manager generations mixed");close(a);check(image(b).pointer!=0,"old generation close freed new generation");close(b);noLeaks();

        ops=reset(true);a=load(manager,"textures/a.png",format);b=load(manager,"textures/a.png",new Object());c=load(manager,"textures/b.png",format);check(ops.reads.get()==3,"format/resource key isolation");close(a);close(b);close(c);noLeaks();

        ops=reset(true);a=load(manager,"textures/a.png",format);shared=image(a);FontImageCache.begin(new Object(),manager);FontImageCache.read(format,new ByteArrayInputStream(new byte[0]),manager,"textures/a.png");FontImageCache.abort(new IOException("glyph construction failed"));check(shared.pointer!=0&&counter("rollbacks")==1,"failed load freed existing owner");close(a);noLeaks();

        ops=reset(true);ops.failRead=true;try{load(manager,"textures/a.png",format);throw new AssertionError("expected decode failure");}catch(IOException expected){}check(ops.closes.get()==0,"failed decode had no allocation to close");noLeaks();ops.failRead=false;a=load(manager,"textures/a.png",format);close(a);check(ops.reads.get()==2,"failure poisoned retry");noLeaks();

        ops=reset(true);ops.failMetadata=true;try{load(manager,"textures/a.png",format);throw new AssertionError("expected metadata failure");}catch(IllegalStateException expected){}check(ops.closes.get()==1&&ops.images.getFirst().pointer==0,"postdecode metadata failure leaked allocation");noLeaks();ops.failMetadata=false;a=load(manager,"textures/a.png",format);close(a);noLeaks();

        ops=reset(true);int parallel=16;ExecutorService pool=Executors.newFixedThreadPool(parallel);CyclicBarrier start=new CyclicBarrier(parallel);List<Future<Object>> futures=new ArrayList<>();
        for(int i=0;i<parallel;i++)futures.add(pool.submit(()->{start.await();try{return load(manager,"textures/a.png",format);}catch(Throwable failure){throw new RuntimeException(failure);}}));
        List<Object> owners=new ArrayList<>();for(Future<Object> f:futures)owners.add(f.get(10,TimeUnit.SECONDS));shared=image(owners.getFirst());for(Object owner:owners)check(image(owner)==shared,"concurrent miss decoded twice");check(ops.reads.get()==1,"inflight decoding was not coalesced");
        for(int i=0;i<parallel-1;i++){close(owners.get(i));check(shared.pointer!=0,"concurrent ref release premature free");}close(owners.getLast());pool.shutdown();check(pool.awaitTermination(10,TimeUnit.SECONDS),"thread shutdown");noLeaks();

        ops=reset(true);Object temporaryManager=new Object();WeakReference<Object> weak=new WeakReference<>(temporaryManager);a=load(temporaryManager,"textures/a.png",format);shared=image(a);temporaryManager=null;
        for(int i=0;i<30&&weak.get()!=null;i++){System.gc();Thread.sleep(5);}FontImageCache.snapshotJson();check(weak.get()==null,"manager unexpectedly strongly retained by cache");check(shared.pointer!=0,"weak generation cleanup freed owned image");close(a);noLeaks();

        ops=reset(true);FontImageCache.verifyPixels=true;a=load(manager,"textures/a.png",format);shared=image(a);shared.pixels[0]=99;check(FontImageCache.auditPixelsJson().contains("\"mismatches\":1"),"pixel mutation was not detected");close(a);check(shared.pointer==0&&counter("pixelDigestMismatches")==1,"integrity mismatch prevented final release");noLeaks();

        ops=reset(true);FontImageCache.verifyPixels=true;a=load(manager,"textures/a.png",format);shared=image(a);ops.failDigest=true;close(a);check(shared.pointer==0,"digest failure prevented native close");noLeaks();

        ops=reset(true);a=load(manager,"textures/a.png",format);FontImageCache.begin(new Object(),manager);FontImageCache.read(format,new ByteArrayInputStream(new byte[0]),manager,"textures/a.png");try{FontImageCache.commit(a);throw new AssertionError("duplicate owner accepted");}catch(IllegalStateException expected){FontImageCache.abort(expected);}check(image(a).pointer!=0,"duplicate-owner rollback damaged existing provider");close(a);noLeaks();

        ops=reset(true);Object outer=new Object(),inner=new Object();FontImageCache.begin(new Object(),manager);FontImageCache.read(format,new ByteArrayInputStream(new byte[0]),manager,"textures/outer.png");FontImageCache.begin(new Object(),manager);FontImageCache.read(format,new ByteArrayInputStream(new byte[0]),manager,"textures/inner.png");FontImageCache.commit(inner);FontImageCache.commit(outer);check(image(inner)!=image(outer),"nested transaction mixed leases");close(outer);close(inner);noLeaks();

        final Ops stressOps=reset(true);int rounds=40;Object[] generations=new Object[rounds];for(int i=0;i<rounds;i++)generations[i]=new Object();
        ExecutorService stress=Executors.newFixedThreadPool(16);CyclicBarrier phase=new CyclicBarrier(16);List<Future<?>> workers=new ArrayList<>();
        for(int i=0;i<16;i++){final int thread=i;workers.add(stress.submit(()->{
            try{for(int round=0;round<rounds;round++){
                phase.await(5,TimeUnit.SECONDS);Object owner=load(generations[round],"textures/shared.png",format);
                phase.await(5,TimeUnit.SECONDS);if(thread==0)check(stressOps.reads.get()==round+1,"parallel reload cohort decoded more than once");
                phase.await(5,TimeUnit.SECONDS);close(owner);phase.await(5,TimeUnit.SECONDS);
                if(thread==0)check(stressOps.closes.get()==round+1,"parallel reload cohort final close count");phase.await(5,TimeUnit.SECONDS);
            }}catch(Throwable failure){throw new RuntimeException(failure);}
        }));}
        try{for(Future<?> worker:workers)worker.get(15,TimeUnit.SECONDS);}finally{stress.shutdownNow();}
        check(stress.awaitTermination(10,TimeUnit.SECONDS),"stress worker shutdown");check(counter("acquires")==640&&counter("releases")==640,"stress acquire/release imbalance");noLeaks();

        System.out.println("{\"status\":\"PASS\",\"test_cases\":"+tests+",\"assertions\":"+assertions+",\"stress_cohorts\":40,\"stress_parallelism\":16,\"stress_acquires\":640,\"native_pixel_array_bytes_per_fake_image\":4,\"minecraft_main_launched\":false}");
    }
}
