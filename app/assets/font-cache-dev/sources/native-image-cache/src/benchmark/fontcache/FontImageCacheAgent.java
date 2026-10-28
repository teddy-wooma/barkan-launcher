package benchmark.fontcache;

import java.io.*;
import java.lang.instrument.*;
import java.nio.file.*;
import java.security.*;
import java.util.*;
import org.objectweb.asm.*;

/** SHA-pinned, two-class on-load instrumentation for vanilla 1.21.11 only. */
public final class FontImageCacheAgent {
    static final String HOOK="benchmark/fontcache/FontImageCache";
    public static void premain(String args,Instrumentation instrumentation)throws Exception{
        Properties pins=new Properties();try(InputStream in=FontImageCacheAgent.class.getResourceAsStream("/font-cache-class-pins.properties")){pins.load(Objects.requireNonNull(in));}
        for(String type:List.of("goh","goh$a")){
            try(InputStream in=ClassLoader.getSystemResourceAsStream(type+".class")){
                if(in==null || !HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(in.readAllBytes())).equals(pins.getProperty(type)))throw new IllegalStateException("Unsupported BitmapProvider bytecode: "+type);
            }
        }
        Map<String,String> options=new HashMap<>();if(args!=null)for(String part:args.split(",")){int at=part.indexOf('=');if(at>0)options.put(part.substring(0,at),part.substring(at+1));}
        boolean enabled=Boolean.parseBoolean(options.getOrDefault("enabled",System.getProperty("barkan.fontImageCache.enabled","true")));
        boolean verify=Boolean.parseBoolean(options.getOrDefault("verifyPixels","false"));
        Path out=options.containsKey("out")?Path.of(options.get("out")).toAbsolutePath():null;
        FontImageCache.configure(enabled,verify,out);instrumentation.addTransformer(new Transformer(),false);
        // Transformer exceptions can be ignored by Instrumentation. Force both
        // pinned classes through the transformer before main and fail premain
        // unless both hooks installed, preventing a partially enabled cache.
        ClassLoader gameLoader=ClassLoader.getSystemClassLoader();
        Class<?> provider=Class.forName("goh",false,gameLoader);
        Class<?> definition=Class.forName("goh$a",false,gameLoader);
        provider.getDeclaredMethod("close");
        definition.getDeclaredMethod("a",Class.forName("baz",false,gameLoader));
        synchronized(FontImageCache.LOCK){
            if(FontImageCache.COUNTERS.get("providerClassTransformed")!=1L || FontImageCache.COUNTERS.get("definitionClassTransformed")!=1L)
                throw new IllegalStateException("Both font image ownership hooks must install before main");
        }
        FontImageCache.mark("premain");
    }
    public static final class Transformer implements ClassFileTransformer {
        public byte[] transform(ClassLoader loader,String name,Class<?> redef,ProtectionDomain domain,byte[] bytes){
            if(!"goh".equals(name)&&!"goh$a".equals(name))return null;
            try{return transformBytes(name,bytes);}catch(Throwable failure){synchronized(FontImageCache.LOCK){FontImageCache.error("Transformation failed: "+name+": "+failure);}throw new IllegalStateException(failure);}
        }
    }
    public static byte[] transformBytes(String name,byte[] input){
        ClassReader reader=new ClassReader(input);ClassWriter writer=new ClassWriter(ClassWriter.COMPUTE_MAXS);int[] hooks=new int[3];
        reader.accept(new ClassVisitor(Opcodes.ASM9,writer){
            public void visitEnd(){if(name.equals("goh"))super.visitField(Opcodes.ACC_PRIVATE,"barkanFontCacheClosed","Z",null,null).visitEnd();super.visitEnd();}
            public MethodVisitor visitMethod(int access,String method,String descriptor,String signature,String[] exceptions){
                if(name.equals("goh")&&method.equals("close")&&descriptor.equals("()V")){
                    hooks[0]++;MethodVisitor mv=super.visitMethod(access|Opcodes.ACC_SYNCHRONIZED,method,descriptor,signature,exceptions);
                    mv.visitCode();Label first=new Label();mv.visitVarInsn(Opcodes.ALOAD,0);mv.visitFieldInsn(Opcodes.GETFIELD,"goh","barkanFontCacheClosed","Z");mv.visitJumpInsn(Opcodes.IFEQ,first);
                    mv.visitMethodInsn(Opcodes.INVOKESTATIC,HOOK,"doubleClose","()V",false);mv.visitInsn(Opcodes.RETURN);
                    mv.visitLabel(first);mv.visitFrame(Opcodes.F_NEW,1,new Object[]{"goh"},0,new Object[]{});
                    mv.visitVarInsn(Opcodes.ALOAD,0);mv.visitInsn(Opcodes.ICONST_1);mv.visitFieldInsn(Opcodes.PUTFIELD,"goh","barkanFontCacheClosed","Z");
                    mv.visitVarInsn(Opcodes.ALOAD,0);mv.visitVarInsn(Opcodes.ALOAD,0);mv.visitFieldInsn(Opcodes.GETFIELD,"goh","c","Lfyh;");
                    mv.visitMethodInsn(Opcodes.INVOKESTATIC,HOOK,"closeProvider","(Ljava/lang/Object;Ljava/lang/Object;)V",false);mv.visitInsn(Opcodes.RETURN);mv.visitMaxs(0,0);mv.visitEnd();return null;
                }
                MethodVisitor original=super.visitMethod(access,method,descriptor,signature,exceptions);
                if(!name.equals("goh$a")||!method.equals("a")||!descriptor.equals("(Lbaz;)Lfwq;"))return original;
                hooks[0]++;
                return new MethodVisitor(Opcodes.ASM9,original){
                    final Label start=new Label(),end=new Label(),handler=new Label();
                    public void visitCode(){super.visitCode();super.visitVarInsn(Opcodes.ALOAD,0);super.visitVarInsn(Opcodes.ALOAD,1);super.visitMethodInsn(Opcodes.INVOKESTATIC,HOOK,"begin","(Ljava/lang/Object;Ljava/lang/Object;)V",false);super.visitLabel(start);}
                    public void visitMethodInsn(int opcode,String owner,String called,String desc,boolean iface){
                        if(opcode==Opcodes.INVOKESTATIC&&owner.equals("fyh")&&called.equals("a")&&desc.equals("(Lfyh$a;Ljava/io/InputStream;)Lfyh;")){
                            hooks[1]++;super.visitVarInsn(Opcodes.ALOAD,1);super.visitVarInsn(Opcodes.ALOAD,2);
                            super.visitMethodInsn(Opcodes.INVOKESTATIC,HOOK,"read","(Ljava/lang/Object;Ljava/io/InputStream;Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;",false);super.visitTypeInsn(Opcodes.CHECKCAST,"fyh");
                        }else super.visitMethodInsn(opcode,owner,called,desc,iface);
                    }
                    public void visitInsn(int opcode){if(opcode==Opcodes.ARETURN){hooks[2]++;super.visitInsn(Opcodes.DUP);super.visitMethodInsn(Opcodes.INVOKESTATIC,HOOK,"commit","(Ljava/lang/Object;)V",false);}super.visitInsn(opcode);}
                    public void visitMaxs(int maxStack,int maxLocals){
                        super.visitLabel(end);super.visitTryCatchBlock(start,end,handler,"java/lang/Throwable");super.visitLabel(handler);
                        // Existing javac frames drop no-longer-live parameter
                        // locals to TOP. This handler only uses its Throwable;
                        // the correct merge therefore has no live locals.
                        super.visitFrame(Opcodes.F_NEW,0,new Object[]{},1,new Object[]{"java/lang/Throwable"});
                        super.visitInsn(Opcodes.DUP);super.visitMethodInsn(Opcodes.INVOKESTATIC,HOOK,"abort","(Ljava/lang/Throwable;)V",false);super.visitInsn(Opcodes.ATHROW);super.visitMaxs(maxStack,maxLocals);
                    }
                };
            }
        },ClassReader.EXPAND_FRAMES);
        if(hooks[0]!=1 || (name.equals("goh$a")&&(hooks[1]!=1||hooks[2]!=1)))throw new IllegalStateException("Unexpected hook layout "+name+Arrays.toString(hooks));
        synchronized(FontImageCache.LOCK){FontImageCache.count(name.equals("goh")?"providerClassTransformed":"definitionClassTransformed");}
        return writer.toByteArray();
    }
}
