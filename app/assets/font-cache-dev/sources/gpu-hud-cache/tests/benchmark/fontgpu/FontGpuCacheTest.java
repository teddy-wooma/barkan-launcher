package benchmark.fontgpu;

import java.util.*;
import java.util.concurrent.*;

/** Fake GPU backend exercises production ownership and cloning code without GL. */
public final class FontGpuCacheTest {
    static int assertions,cases;
    static Fake backend;
    static final Object FORMAT=new Object();
    record Info(int advance,float bold,float shadow){}
    record Sheet(Object image,Object format,int x,int y,int width,int height,boolean colored,float left,float right,float up,float down,String special,boolean unknown){}
    record Baked(Object info,Object storage,float left,float right,float up,float down){}
    static final class Source {int uploads,clears;boolean disposed;final List<Baked> uploaded=new ArrayList<>();final List<Sheet> sheets=new ArrayList<>();}
    static final class Manager {final List<Source> fonts=new ArrayList<>();Source missing;boolean failCreate,failApply,failUpload;int publishBeforeFailure;}
    static final class Fake implements FontGpuCache.Backend {
        final Thread render=Thread.currentThread();final List<Source> pools=new ArrayList<>();final Set<Source> failClearOnce=Collections.newSetFromMap(new IdentityHashMap<>());int closes;
        public void assertRenderThread(){if(Thread.currentThread()!=render)throw new IllegalStateException("Not render thread");}
        public Object textureManager(Object manager){return manager;}
        public Object newPool(Object tm,String id){Source source=new Source();pools.add(source);return source;}
        public Object originalCreate(Object value,Object id,Object providers,Object options){
            Manager manager=(Manager)value;Source source=new Source();
            FontGpuCache.clearStitcher(source);
            FontGpuCache.stitch(source,new Info(6,1,1),FontGpuCacheTest.special("MISSING"));
            FontGpuCache.stitch(source,new Info(6,1,1),FontGpuCacheTest.special("WHITE"));
            if(manager.failCreate)throw new IllegalStateException("Creation failed after shared upload");return source;
        }
        public void originalApply(Object value,Object preparation,Object barrier){
            Manager manager=(Manager)value;for(Source old:new ArrayList<>(manager.fonts))FontGpuCache.closeStitcher(old);manager.fonts.clear();
            int n=(Integer)preparation;for(int i=0;i<n;i++){Source source=(Source)FontGpuCache.createFontSet(manager,"font"+i,List.of(),Set.of());manager.fonts.add(source);if(manager.failApply&&i+1==manager.publishBeforeFailure)throw new IllegalStateException("Partial publication failure");}
        }
        public void originalManagerClose(Object value){Manager manager=(Manager)value;for(Source source:manager.fonts)FontGpuCache.closeStitcher(source);if(manager.missing!=null)FontGpuCache.closeStitcher(manager.missing);closes++;}
        public Object originalStitch(Object value,Object info,Object valueSheet){
            Source source=(Source)value;Sheet sheet=(Sheet)valueSheet;
            if(source.disposed)throw new AssertionError("Upload to destroyed source");
            Object storage=new Object();Baked baked=new Baked(info,storage,sheet.left,sheet.right,sheet.up,sheet.down);source.uploads++;source.uploaded.add(baked);source.sheets.add(sheet);return baked;
        }
        public void originalClear(Object value){Source source=(Source)value;source.clears++;if(failClearOnce.remove(source))throw new IllegalStateException("Injected pool clear failure");source.uploaded.clear();source.sheets.clear();}
        public void originalClose(Object value){FontGpuCache.clearStitcher(value);((Source)value).disposed=true;}
        public Set<Object> publishedStitchers(Object value){Manager manager=(Manager)value;Set<Object> result=Collections.newSetFromMap(new IdentityHashMap<>());result.addAll(manager.fonts);if(manager.missing!=null)result.add(manager.missing);return result;}
        public String special(Object info,Object sheet){return ((Sheet)sheet).special;}
        public FontGpuCache.CellKey bitmapKey(Object value){Sheet sheet=(Sheet)value;return sheet.unknown?null:new FontGpuCache.CellKey(sheet.image,sheet.format,sheet.x,sheet.y,sheet.width,sheet.height,sheet.colored);}
        public Object storage(Object value){return ((Baked)value).storage;}
        public Object cloneGlyph(Object storage,Object info,Object value){Sheet sheet=(Sheet)value;return new Baked(info,storage,sheet.left,sheet.right,sheet.up,sheet.down);}
        public long[] usage(Object value){Source source=(Source)value;boolean rgba=false,red=false;for(Baked b:source.uploaded){rgba=true;}return new long[]{rgba?1:0,rgba?262144:0};}
    }
    static Sheet special(String name){return new Sheet(null,null,0,0,5,8,true,0,5,0,8,name,false);}
    static Sheet cell(Object image,int x,int y,int width,int height,float scale){return new Sheet(image,FORMAT,x,y,width,height,true,1*scale,3*scale,-2*scale,8*scale,null,false);}
    static void check(boolean condition,String message){assertions++;if(!condition)throw new AssertionError(message);}
    static void reset(boolean enabled){
        synchronized(FontGpuCache.LOCK){FontGpuCache.MANAGERS.clear();FontGpuCache.BINDINGS.clear();FontGpuCache.CLOSED_SOURCES.clear();FontGpuCache.CLOSED_MANAGERS.clear();FontGpuCache.COUNTERS.clear();FontGpuCache.ERRORS.clear();FontGpuCache.HISTORY.clear();FontGpuCache.sequence=0;FontGpuCache.SCOPES.remove();backend=new Fake();FontGpuCache.backend=backend;FontGpuCache.configure(enabled,true,null);}
    }
    static Manager manager(){Manager m=new Manager();m.missing=(Source)FontGpuCache.createFontSet(m,"missing",List.of(),Set.of());return m;}
    static long number(String key){return ((Number)FontGpuCache.snapshot().get(key)).longValue();}
    static void zero(){check(number("activeManagers")==0,"Manager retained");check(number("activeOwnerBindings")==0,"Owner retained");check(number("activeLeases")==0,"Lease leaked");check(number("liveGenerations")==0,"Generation leaked");check(number("liveSharedPages")==0,"Page leaked");check(number("cellEntries")==0,"Native image key retained");check(FontGpuCache.ERRORS.isEmpty(),"Error log nonempty");}
    static void sharedSpecialLifetime(){reset(true);Manager m=manager();FontGpuCache.apply(m,4,null);cases++;
        check(backend.pools.size()==2,"Bootstrap must use distinct pool");
        Source first=m.fonts.get(0),second=m.fonts.get(1);Baked a=(Baked)FontGpuCache.stitch(first,new Info(6,1,1),special("WHITE"));Baked b=(Baked)FontGpuCache.stitch(second,new Info(6,1,1),special("WHITE"));
        check(a==b,"Special glyph not shared");FontGpuCache.closeStitcher(first);check(number("liveSharedPages")==2,"One owner freed shared page");check(((Baked)FontGpuCache.stitch(second,new Info(6,1,1),special("WHITE")))==b,"Other font lost special");FontGpuCache.closeManager(m);zero();
    }
    static void ownMetrics(){reset(true);Manager m=manager();FontGpuCache.apply(m,2,null);cases++;Object image=new Object();Sheet s1=cell(image,3,5,8,9,1),s2=cell(image,3,5,8,9,17);Info i1=new Info(7,1,2),i2=new Info(320,3,4);
        Baked a=(Baked)FontGpuCache.stitch(m.fonts.get(0),i1,s1),b=(Baked)FontGpuCache.stitch(m.fonts.get(1),i2,s2);
        check(a!=b,"Normal BakedGlyph object shared");check(a.storage==b.storage,"Same cells did not reuse storage");check(a.info==i1&&b.info==i2,"Advance/bold/shadow info changed");check(a.up==-2&&b.up==-34&&a.down==8&&b.down==136,"Caller bearings/scale changed");check(number("cellEntries")==1,"Wrong cell dedupe");FontGpuCache.closeManager(m);zero();
    }
    static void keys(){reset(true);cases++;Object image=new Object();FontGpuCache.CellKey key=new FontGpuCache.CellKey(image,FORMAT,1,2,3,4,true);
        check(key.equals(new FontGpuCache.CellKey(image,FORMAT,1,2,3,4,true)),"Equal key");check(key.hashCode()==new FontGpuCache.CellKey(image,FORMAT,1,2,3,4,true).hashCode(),"Equal hash");
        check(!key.equals(new FontGpuCache.CellKey(new Object(),FORMAT,1,2,3,4,true)),"Different image merged");check(!key.equals(new FontGpuCache.CellKey(image,new Object(),1,2,3,4,true)),"Different format merged");
        check(!key.equals(new FontGpuCache.CellKey(image,FORMAT,0,2,3,4,true)),"Different src x merged");check(!key.equals(new FontGpuCache.CellKey(image,FORMAT,1,0,3,4,true)),"Different src y merged");check(!key.equals(new FontGpuCache.CellKey(image,FORMAT,1,2,9,4,true)),"Different width merged");check(!key.equals(new FontGpuCache.CellKey(image,FORMAT,1,2,3,9,true)),"Different height merged");check(!key.equals(new FontGpuCache.CellKey(image,FORMAT,1,2,3,4,false)),"RED8/RGBA8 merged");
    }
    static void reloadAndOptions(){reset(true);Manager m=manager();cases++;
        for(int generation=0;generation<40;generation++){
            FontGpuCache.apply(m,12,null);Object image=new Object();for(Source source:m.fonts)FontGpuCache.stitch(source,new Info(generation,1,2),cell(image,0,0,16,16,1));
            check(number("liveGenerations")==2,"Old reload generation retained");check(number("activeLeases")==13,"Wrong refs");check(number("cellEntries")==1,"Old source image keys retained");
            for(Source source:m.fonts){FontGpuCache.clearStitcher(source);FontGpuCache.stitch(source,new Info(6,1,1),special("MISSING"));FontGpuCache.stitch(source,new Info(6,1,1),special("WHITE"));}
        }
        FontGpuCache.closeManager(m);zero();check(FontGpuCache.COUNTERS.get("ownerAcquire").equals(FontGpuCache.COUNTERS.get("ownerRelease")),"Ref acquire/release mismatch");
    }
    static void lastOwnerReopens(){reset(true);Manager m=manager();FontGpuCache.apply(m,1,null);cases++;Source source=m.fonts.get(0);int pools=backend.pools.size();FontGpuCache.clearStitcher(source);check(number("activeLeases")==1,"Last normal lease not released");FontGpuCache.stitch(source,new Info(6,1,1),special("WHITE"));check(backend.pools.size()==pools+1,"Cleared current gen cannot lazily reopen");FontGpuCache.closeManager(m);zero();}
    static void failures(){reset(true);Manager m=manager();FontGpuCache.apply(m,2,null);cases++;m.failCreate=true;long owners=number("activeLeases");boolean thrown=false;try{FontGpuCache.createFontSet(m,"bad",List.of(),Set.of());}catch(IllegalStateException expected){thrown=true;}check(thrown,"Create failure swallowed");check(number("activeLeases")==owners,"Create failure ref leaked");m.failCreate=false;
        m.failApply=true;m.publishBeforeFailure=2;thrown=false;try{FontGpuCache.apply(m,4,null);}catch(IllegalStateException expected){thrown=true;}check(thrown,"Apply failure swallowed");check(m.fonts.size()==2,"Partial font not published");check(number("activeLeases")==3,"Published partial fonts lost lease");FontGpuCache.stitch(m.fonts.get(0),new Info(6,1,1),special("WHITE"));FontGpuCache.closeManager(m);zero();}
    static void offAndFallback(){reset(false);Manager m=manager();FontGpuCache.apply(m,2,null);cases++;Object image=new Object();Source a=m.fonts.get(0),b=m.fonts.get(1);Baked x=(Baked)FontGpuCache.stitch(a,new Info(4,1,1),cell(image,0,0,4,4,1)),y=(Baked)FontGpuCache.stitch(b,new Info(4,1,1),cell(image,0,0,4,4,1));check(x.storage!=y.storage,"OFF reused GPU storage");check(backend.pools.isEmpty(),"OFF allocated shared pool");FontGpuCache.closeManager(m);zero();
        reset(true);m=manager();FontGpuCache.apply(m,1,null);Source s=m.fonts.get(0);int uploads=s.uploads;Sheet unknown=new Sheet(image,FORMAT,0,0,4,4,true,1,2,3,4,null,true);FontGpuCache.stitch(s,new Info(4,1,1),unknown);check(s.uploads==uploads+1,"Unknown glyph did not fallback");FontGpuCache.closeManager(m);zero();}
    static void duplicateAndThread()throws Exception{reset(true);Manager m=manager();FontGpuCache.apply(m,2,null);cases++;Source source=m.fonts.get(0);FontGpuCache.closeStitcher(source);long refs=number("activeLeases");FontGpuCache.closeStitcher(source);check(number("activeLeases")==refs,"Double close changed refs");FontGpuCache.closeManager(m);FontGpuCache.closeManager(m);check(backend.closes==1,"Manager original double close");zero();
        ExecutorService executor=Executors.newSingleThreadExecutor();try{check(executor.submit(()->{try{FontGpuCache.clearStitcher(new Source());return false;}catch(IllegalStateException expected){return true;}}).get(),"Off-render GPU mutation accepted");}finally{executor.shutdownNow();}}
    static void multiManager(){reset(true);cases++;Manager a=manager(),b=manager();FontGpuCache.apply(a,2,null);FontGpuCache.apply(b,2,null);check(number("liveGenerations")==4,"Manager scopes merged");Object image=new Object();Baked x=(Baked)FontGpuCache.stitch(a.fonts.get(0),new Info(1,1,1),cell(image,0,0,8,8,1)),y=(Baked)FontGpuCache.stitch(b.fonts.get(0),new Info(1,1,1),cell(image,0,0,8,8,1));check(x.storage!=y.storage,"Independent manager pools merged");FontGpuCache.closeManager(a);check(number("liveGenerations")==2,"Closing manager killed second manager");FontGpuCache.closeManager(b);zero();}
    static void smallTextIsolation(){
        reset(true);FontGpuCache.configure(true,true,null,"small-text",22,32);Manager m=manager();FontGpuCache.apply(m,2,null);cases++;
        Object image=new Object();Info i1=new Info(7,1,2),i2=new Info(200,3,4);
        Sheet t1=cell(image,2,5,14,22,1),t2=cell(image,2,5,14,22,17);
        Baked a=(Baked)FontGpuCache.stitch(m.fonts.get(0),i1,t1),b=(Baked)FontGpuCache.stitch(m.fonts.get(1),i2,t2);
        FontGpuCache.stitch(m.fonts.get(0),i1,cell(image,0,40,192,104,1));
        FontGpuCache.stitch(m.fonts.get(0),i1,cell(image,0,150,9,9,1));
        FontGpuCache.Generation generation=FontGpuCache.BINDINGS.get(m.fonts.get(0)).assigned;
        check(generation.pools.keySet().equals(Set.of("main","small-text-h22-w32")),"Expected exactly separate main/text pools");
        Source text=(Source)generation.pools.get("small-text-h22-w32").stitcher;
        check(text.sheets.size()==1&&text.sheets.get(0).height==22&&text.sheets.get(0).width==14,"Text pool contains unrelated UI/special glyph");
        check(a!=b&&a.storage==b.storage&&a.info==i1&&b.info==i2,"Text storage sharing changed per-glyph info");
        check(a.up==-2&&b.up==-34&&a.down==8&&b.down==136,"Text storage sharing changed current bearings");
        FontGpuCache.closeStitcher(m.fonts.get(0));check(number("activeLeases")==2,"One owner affected remaining text pool leases");
        FontGpuCache.closeManager(m);zero();
        check(FontGpuCache.COUNTERS.get("poolCreate").equals(FontGpuCache.COUNTERS.get("poolClose")),"Multi-pool create/close mismatch");
        check(FontGpuCache.HISTORY.stream().anyMatch(row->row.get("poolGroup").equals("small-text-h22-w32")&&row.get("sharedPages").equals(0L)),"Missing explicit text-pool zero tombstone");
    }
    static void selectorBoundaries(){
        reset(true);FontGpuCache.configure(true,true,null,"small-text",22,32);cases++;Object image=new Object();
        check(FontGpuCache.group(new FontGpuCache.CellKey(image,FORMAT,0,0,1,22,true)).equals("small-text-h22-w32"),"Minimum positive width rejected");
        check(FontGpuCache.group(new FontGpuCache.CellKey(image,FORMAT,0,0,32,22,true)).equals("small-text-h22-w32"),"Maximum width rejected");
        for(int[] shape:new int[][]{{0,22},{33,22},{14,21},{14,23},{64,96},{192,104}})check(FontGpuCache.group(new FontGpuCache.CellKey(image,FORMAT,0,0,shape[0],shape[1],true)).equals("main"),"UI/different-height cell contaminated text pool");
        boolean rejected=false;try{FontGpuCache.configure(true,true,null,"unknown",22,32);}catch(IllegalArgumentException expected){rejected=true;}check(rejected,"Unknown policy accepted");
        rejected=false;try{FontGpuCache.configure(true,true,null,"small-text",0,32);}catch(IllegalArgumentException expected){rejected=true;}check(rejected,"Invalid selector accepted");
        reset(false);FontGpuCache.configure(false,true,null,"small-text",22,32);Manager m=manager();FontGpuCache.apply(m,2,null);FontGpuCache.stitch(m.fonts.get(0),new Info(7,1,1),cell(image,0,0,14,22,1));check(backend.pools.isEmpty(),"OFF created a grouped shared pool");FontGpuCache.closeManager(m);zero();
    }
    static void groupedReloads(){
        reset(true);FontGpuCache.configure(true,true,null,"small-text",22,32);Manager m=manager();cases++;
        for(int i=0;i<20;i++){
            FontGpuCache.apply(m,8,null);Object image=new Object();for(Source source:m.fonts){FontGpuCache.stitch(source,new Info(i,1,1),cell(image,0,0,14,22,1));FontGpuCache.stitch(source,new Info(i,1,1),cell(image,0,40,64,96,1));}
            check(number("liveGenerations")==2&&number("activeLeases")==9,"Grouped reload retained prior generation");
            check(number("cellEntries")==2,"Grouped reload retained prior source image");
            for(Source source:m.fonts){FontGpuCache.clearStitcher(source);FontGpuCache.stitch(source,new Info(6,1,1),special("WHITE"));FontGpuCache.stitch(source,new Info(i,1,1),cell(image,0,0,14,22,1));}
        }
        FontGpuCache.closeManager(m);zero();check(FontGpuCache.COUNTERS.get("poolCreate").equals(FontGpuCache.COUNTERS.get("poolClose")),"Grouped reload pool leak");check(FontGpuCache.COUNTERS.get("ownerAcquire").equals(FontGpuCache.COUNTERS.get("ownerRelease")),"Grouped reload owner leak");
    }
    static void closeFailuresAttemptAllGroups(){
        for(boolean both:new boolean[]{false,true}){
            reset(true);FontGpuCache.configure(true,true,null,"small-text",22,32);Manager m=manager();FontGpuCache.apply(m,1,null);cases++;
            Source source=m.fonts.get(0);FontGpuCache.stitch(source,new Info(8,1,1),cell(new Object(),0,0,14,22,1));
            FontGpuCache.Generation generation=FontGpuCache.BINDINGS.get(source).assigned;
            Source main=(Source)generation.pools.get("main").stitcher,text=(Source)generation.pools.get("small-text-h22-w32").stitcher;
            backend.failClearOnce.add(main);if(both)backend.failClearOnce.add(text);
            RuntimeException thrown=null;try{FontGpuCache.closeStitcher(source);}catch(RuntimeException expected){thrown=expected;}
            check(thrown!=null,"Pool close failure swallowed");check(thrown.getSuppressed().length==(both?1:0),"Independent close failures not preserved");
            check(main.clears==1&&text.clears==1,"Later group close not attempted");check(source.clears==2,"Shared failure skipped original fallback cleanup");
            check(generation.pools.size()==(both?2:1),"Failed group discarded or successful group retained");
            check(FontGpuCache.COUNTERS.get("poolCloseFailures")== (both?2L:1L),"Close failure counter missing");
            check(FontGpuCache.ERRORS.size()==(both?2:1),"Close failure evidence hidden");
            FontGpuCache.closeManager(m);
            for(String field:List.of("activeManagers","activeOwnerBindings","activeLeases","liveGenerations","liveSharedPages","cellEntries"))check(number(field)==0,"Failed-group retry leaked "+field);
            check(FontGpuCache.COUNTERS.get("ownerAcquire").equals(FontGpuCache.COUNTERS.get("ownerRelease")),"Failed close changed lease balance");
        }
    }
    public static void main(String[]args)throws Exception{sharedSpecialLifetime();ownMetrics();keys();reloadAndOptions();lastOwnerReopens();failures();offAndFallback();duplicateAndThread();multiManager();smallTextIsolation();selectorBoundaries();groupedReloads();closeFailuresAttemptAllGroups();System.out.println("{\"status\":\"PASS\",\"cases\":"+cases+",\"assertions\":"+assertions+",\"reload_cohorts\":60,\"minecraft_main_launched\":false}");}
}
