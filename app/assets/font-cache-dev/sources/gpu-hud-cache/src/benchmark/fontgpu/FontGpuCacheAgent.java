package benchmark.fontgpu;

import java.io.*;
import java.lang.instrument.*;
import java.nio.file.*;
import java.security.*;
import java.util.*;
import org.objectweb.asm.*;

/** Strict vanilla-bytecode experiment; refuses modified or unsupported inputs. */
public final class FontGpuCacheAgent {
    static final String HOOK="benchmark/fontgpu/FontGpuCache";
    static Properties pins;
    public static void premain(String args,Instrumentation instrumentation)throws Exception {
        pins=new Properties();try(InputStream input=FontGpuCacheAgent.class.getResourceAsStream("/font-gpu-class-pins.properties")){pins.load(Objects.requireNonNull(input));}
        for(String type:pins.stringPropertyNames())try(InputStream input=ClassLoader.getSystemResourceAsStream(type+".class")){
            if(input==null||!digest(input.readAllBytes()).equals(pins.getProperty(type)))throw new IllegalStateException("Unsupported GPU font bytecode: "+type);
        }
        Map<String,String> options=new HashMap<>();if(args!=null)for(String part:args.split(",")){int at=part.indexOf('=');if(at>0)options.put(part.substring(0,at),part.substring(at+1));}
        boolean enabled=Boolean.parseBoolean(options.getOrDefault("enabled","true"));
        boolean cells=Boolean.parseBoolean(options.getOrDefault("shareBitmapCells","true"));
        String policy=options.getOrDefault("poolPolicy","small-text");
        int textHeight=Integer.parseInt(options.getOrDefault("smallTextRawHeight","22"));
        int maxWidth=Integer.parseInt(options.getOrDefault("smallTextMaxRawWidth","32"));
        // Native sharing is part of the controlled OFF/ON experiment, and makes
        // identical resource rectangles refer to the same immutable image.
        Class<?> nativeCache=Class.forName("benchmark.fontcache.FontImageCache");
        String nativeStats=(String)nativeCache.getMethod("snapshotJson").invoke(null);
        if(!nativeStats.contains("\"enabled\":true"))throw new IllegalStateException("Native font image cache must be ON before GPU agent");
        FontGpuCache.configure(enabled,cells,options.containsKey("out")?Path.of(options.get("out")).toAbsolutePath():null,policy,textHeight,maxWidth);
        instrumentation.addTransformer(new Transformer(),false);
        ClassLoader loader=ClassLoader.getSystemClassLoader();
        Class<?> stitcher=Class.forName("gnu",false,loader),manager=Class.forName("gnp",false,loader);
        stitcher.getDeclaredMethod("a",Class.forName("fwp",false,loader),Class.forName("fwo",false,loader));
        stitcher.getDeclaredMethod("barkanGpuOriginalClear");stitcher.getDeclaredMethod("close");
        manager.getDeclaredMethod("a",Class.forName("amo",false,loader),List.class,Set.class);
        manager.getDeclaredMethod("a",Class.forName("gnp$e",false,loader),Class.forName("bzm",false,loader));
        manager.getDeclaredMethod("close");
        synchronized(FontGpuCache.LOCK){if(FontGpuCache.COUNTERS.getOrDefault("stitcherClassTransformed",0L)!=1||FontGpuCache.COUNTERS.getOrDefault("managerClassTransformed",0L)!=1)throw new IllegalStateException("Both GPU font hooks must install before main");}
        FontGpuCache.mark("premain");
    }
    static String digest(byte[] bytes)throws NoSuchAlgorithmException{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));}
    static final class Transformer implements ClassFileTransformer {
        public byte[] transform(ClassLoader loader,String name,Class<?> redef,ProtectionDomain domain,byte[] bytes){
            if(!"gnu".equals(name)&&!"gnp".equals(name))return null;
            try{if(!digest(bytes).equals(pins.getProperty(name)))throw new IllegalStateException("Transformed input SHA mismatch: "+name);return transformBytes(name,bytes);}
            catch(Throwable failure){synchronized(FontGpuCache.LOCK){FontGpuCache.error("Transform: "+name+": "+failure);}throw new IllegalStateException(failure);}
        }
    }
    static record Hook(String original,String descriptor,String renamed,String helper,String helperDescriptor,boolean returnsObject,int arguments,String cast){}
    static List<Hook> hooks(String name){return name.equals("gnu")?List.of(
        new Hook("a","(Lfwp;Lfwo;)Lgob;","barkanGpuOriginalStitch","stitch","(Ljava/lang/Object;Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;",true,2,"gob"),
        new Hook("a","()V","barkanGpuOriginalClear","clearStitcher","(Ljava/lang/Object;)V",false,0,null),
        new Hook("close","()V","barkanGpuOriginalClose","closeStitcher","(Ljava/lang/Object;)V",false,0,null)
    ):List.of(
        new Hook("a","(Lamo;Ljava/util/List;Ljava/util/Set;)Lgnr;","barkanGpuOriginalCreate","createFontSet","(Ljava/lang/Object;Ljava/lang/Object;Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;",true,3,"gnr"),
        new Hook("a","(Lgnp$e;Lbzm;)V","barkanGpuOriginalApply","apply","(Ljava/lang/Object;Ljava/lang/Object;Ljava/lang/Object;)V",false,2,null),
        new Hook("close","()V","barkanGpuOriginalClose","closeManager","(Ljava/lang/Object;)V",false,0,null)
    );}
    public static byte[] transformBytes(String name,byte[] input){
        ClassReader reader=new ClassReader(input);ClassWriter writer=new ClassWriter(ClassWriter.COMPUTE_MAXS);
        Set<Hook> found=new HashSet<>();
        reader.accept(new ClassVisitor(Opcodes.ASM9,writer){
            public MethodVisitor visitMethod(int access,String method,String descriptor,String signature,String[] exceptions){
                for(Hook hook:hooks(name))if(method.equals(hook.original)&&descriptor.equals(hook.descriptor)){
                    if(!found.add(hook))throw new IllegalStateException("Duplicate hook "+name+method+descriptor);
                    MethodVisitor wrapper=super.visitMethod(access,method,descriptor,signature,exceptions);wrapper.visitCode();
                    for(int local=0;local<=hook.arguments;local++)wrapper.visitVarInsn(Opcodes.ALOAD,local);
                    wrapper.visitMethodInsn(Opcodes.INVOKESTATIC,HOOK,hook.helper,hook.helperDescriptor,false);
                    if(hook.returnsObject){wrapper.visitTypeInsn(Opcodes.CHECKCAST,hook.cast);wrapper.visitInsn(Opcodes.ARETURN);}else wrapper.visitInsn(Opcodes.RETURN);
                    wrapper.visitMaxs(0,0);wrapper.visitEnd();
                    return super.visitMethod(access|Opcodes.ACC_SYNTHETIC,hook.renamed,descriptor,signature,exceptions);
                }
                return super.visitMethod(access,method,descriptor,signature,exceptions);
            }
        },0);
        if(found.size()!=3)throw new IllegalStateException("Missing expected hooks "+name+": "+found.size());
        synchronized(FontGpuCache.LOCK){FontGpuCache.count(name.equals("gnu")?"stitcherClassTransformed":"managerClassTransformed");}
        return writer.toByteArray();
    }
}
