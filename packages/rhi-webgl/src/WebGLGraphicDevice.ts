import {
  BufferBindFlag,
  BufferUsage,
  CameraClearFlags,
  Canvas,
  ColorWriteMask,
  Engine,
  GLCapabilityType,
  IHardwareRenderer,
  IPlatformBuffer,
  IPlatformRenderTarget,
  IPlatformTexture2D,
  IPlatformTextureCube,
  Logger,
  Mesh,
  Platform,
  RenderTarget,
  SubMesh,
  SystemInfo,
  Texture2D,
  Texture2DArray,
  TextureCube
} from "@galacean/engine-core";
import { IPlatformPrimitive } from "@galacean/engine-design";
import { Color, Vector4 } from "@galacean/engine-math";
import { GLBuffer } from "./GLBuffer";
import { GLCapability } from "./GLCapability";
import { GLExtensions } from "./GLExtensions";
import { GLPrimitive } from "./GLPrimitive";
import { GLRenderStates } from "./GLRenderStates";
import { GLRenderTarget } from "./GLRenderTarget";
import { GLTexture } from "./GLTexture";
import { GLTexture2D } from "./GLTexture2D";
import { GLTexture2DArray } from "./GLTexture2DArray";
import { GLTextureCube } from "./GLTextureCube";
import { WebGLExtension } from "./type";
import { WebCanvas } from "./WebCanvas";

/**
 * WebGL mode.
 */
export enum WebGLMode {
  /** Auto, use WebGL2.0 if support, or will fallback to WebGL1.0. */
  Auto = 0,
  /** WebGL2.0. */
  WebGL2 = 1,
  /** WebGL1.0, */
  WebGL1 = 2
}

/**
 * WebGL graphic device options.
 */
export interface WebGLGraphicDeviceOptions extends WebGLContextAttributes {
  /** WebGL mode.*/
  webGLMode?: WebGLMode;

  /**
   * @internal
   * iOS 15 webgl implement has bug, maybe should force call flush command buffer, for example iPhone13(iOS 15.4.1).
   */
  _forceFlush?: boolean;
}

/**
 * WebGL graphic device, including WebGL1.0 and WebGL2.0.
 */
export class WebGLGraphicDevice implements IHardwareRenderer {
  /** @internal */
  _readFrameBuffer: WebGLFramebuffer = null;
  /** @internal */
  _enableGlobalDepthBias: boolean = false;
  /** @internal */
  _currentBindShaderProgram: any;

  private _options: WebGLGraphicDeviceOptions;
  private _gl: (WebGLRenderingContext & WebGLExtension) | WebGL2RenderingContext;
  private _renderStates;
  private _extensions;
  private _capability: GLCapability;
  private _isWebGL2: boolean;
  private _renderer: string;
  private _webCanvas: HTMLCanvasElement | OffscreenCanvas;

  private _activeTextureID: number;
  private _activeTextures: GLTexture[] = new Array(32);

  private _lastViewport: Vector4 = new Vector4(null, null, null, null);
  private _lastScissor: Vector4 = new Vector4(null, null, null, null);
  private _lastClearColor: Color = new Color(null, null, null, null);
  private _scissorEnable: boolean = false;

  private _onDeviceLost: () => void;
  private _onDeviceRestored: () => void;

  get isWebGL2(): boolean {
    return this._isWebGL2;
  }

  get renderer(): string {
    return this._renderer;
  }

  /**
   * GL Context
   * @member {WebGLRenderingContext}
   */
  get gl() {
    return this._gl;
  }

  get renderStates(): GLRenderStates {
    return this._renderStates;
  }

  get capability(): GLCapability {
    return this._capability;
  }

  get canIUseMoreJoints() {
    return this.capability.canIUseMoreJoints;
  }

  constructor(initializeOptions: WebGLGraphicDeviceOptions = {}) {
    const options = {
      webGLMode: WebGLMode.Auto,
      stencil: true,
      _forceFlush: false,
      ...initializeOptions
    };
    if (SystemInfo.platform === Platform.IPhone || SystemInfo.platform === Platform.IPad) {
      const version = SystemInfo.operatingSystem.match(/(\d+).?(\d+)?.?(\d+)?/);
      if (version) {
        const majorVersion = parseInt(version[1]);
        const minorVersion = parseInt(version[2]);
        if (majorVersion === 15 && minorVersion >= 0 && minorVersion <= 4) {
          options._forceFlush = true;
        }
      }
    }
    this._options = options;

    this._onWebGLContextLost = this._onWebGLContextLost.bind(this);
    this._onWebGLContextRestored = this._onWebGLContextRestored.bind(this);
  }

  init(canvas: Canvas, onDeviceLost: () => void, onDeviceRestored: () => void): void {
    const options = this._options;
    const webCanvas = (canvas as WebCanvas)._webCanvas;
    const webGLMode = options.webGLMode;

    this._onDeviceLost = onDeviceLost;
    this._onDeviceRestored = onDeviceRestored;
    webCanvas.addEventListener("webglcontextlost", this._onWebGLContextLost, false);
    webCanvas.addEventListener("webglcontextrestored", this._onWebGLContextRestored, false);
    webCanvas.addEventListener("webglcontextcreationerror", this._onContextCreationError, false);

    this._webCanvas = webCanvas;

    let gl: (WebGLRenderingContext & WebGLExtension) | WebGL2RenderingContext;
    if (webGLMode == WebGLMode.Auto || webGLMode == WebGLMode.WebGL2) {
      gl = webCanvas.getContext("webgl2", options);
      if (!gl && (typeof OffscreenCanvas === "undefined" || !(webCanvas instanceof OffscreenCanvas))) {
        gl = <WebGL2RenderingContext>webCanvas.getContext("experimental-webgl2", options);
      }
      this._isWebGL2 = true;

      // Prevent weird browsers to lie (such as safari!)
      if (gl && !(<WebGL2RenderingContext>gl).deleteQuery) {
        this._isWebGL2 = false;
      }
    }

    if (!gl) {
      if (webGLMode == WebGLMode.Auto || webGLMode == WebGLMode.WebGL1) {
        gl = <WebGLRenderingContext & WebGLExtension>webCanvas.getContext("webgl", options);
        if (!gl && (typeof OffscreenCanvas === "undefined" || !(webCanvas instanceof OffscreenCanvas))) {
          gl = <WebGLRenderingContext & WebGLExtension>webCanvas.getContext("experimental-webgl", options);
        }
        this._isWebGL2 = false;
      }
    }

    if (!gl) {
      throw new Error("Get GL Context FAILED.");
    }

    this._gl = gl;
    this._initGLState(gl);
  }

  createPlatformPrimitive(primitive: Mesh): IPlatformPrimitive {
    return new GLPrimitive(this, primitive);
  }

  createPlatformTexture2D(texture2D: Texture2D): IPlatformTexture2D {
    return new GLTexture2D(this, texture2D);
  }

  createPlatformTexture2DArray(texture2D: Texture2DArray): GLTexture2DArray {
    return new GLTexture2DArray(this, texture2D);
  }

  createPlatformTextureCube(textureCube: TextureCube): IPlatformTextureCube {
    return new GLTextureCube(this, textureCube);
  }

  createPlatformRenderTarget(target: RenderTarget): IPlatformRenderTarget {
    return new GLRenderTarget(this, target);
  }

  createPlatformBuffer(
    type: BufferBindFlag,
    byteLength: number,
    bufferUsage: BufferUsage = BufferUsage.Static,
    data?: ArrayBuffer | ArrayBufferView
  ): IPlatformBuffer {
    return new GLBuffer(this, type, byteLength, bufferUsage, data);
  }

  requireExtension(ext) {
    return this._extensions.requireExtension(ext);
  }

  canIUse(capabilityType: GLCapabilityType) {
    return this.capability.canIUse(capabilityType);
  }

  canIUseCompressedTextureInternalFormat(type: number) {
    return this.capability.canIUseCompressedTextureInternalFormat(type);
  }

  viewport(x: number, y: number, width: number, height: number): void {
    const { _gl: gl, _lastViewport: lastViewport } = this;
    if (x !== lastViewport.x || y !== lastViewport.y || width !== lastViewport.z || height !== lastViewport.w) {
      gl.viewport(x, y, width, height);
      lastViewport.set(x, y, width, height);
    }
  }

  scissor(x: number, y: number, width: number, height: number): void {
    const { _gl: gl, _lastScissor: lastScissor } = this;
    if (x !== lastScissor.x || y !== lastScissor.y || width !== lastScissor.z || height !== lastScissor.w) {
      const { _webCanvas: webCanvas } = this;
      if (x === 0 && y === 0 && width === webCanvas.width && height === webCanvas.height) {
        if (this._scissorEnable) {
          gl.disable(gl.SCISSOR_TEST);
          this._scissorEnable = false;
        }
      } else {
        if (!this._scissorEnable) {
          gl.enable(gl.SCISSOR_TEST);
          this._scissorEnable = true;
        }
        gl.scissor(x, y, width, height);
      }
      lastScissor.set(x, y, width, height);
    }
  }

  colorMask(r: boolean, g: boolean, b: boolean, a: boolean): void {
    this._gl.colorMask(r, g, b, a);
  }

  clearRenderTarget(engine: Engine, clearFlags: CameraClearFlags, clearColor: Color) {
    const gl = this._gl;

    const {
      blendState: { targetBlendState },
      depthState,
      stencilState
      // @ts-ignore
    } = engine._lastRenderState;
    let clearFlag = 0;
    if (clearFlags & CameraClearFlags.Color) {
      clearFlag |= gl.COLOR_BUFFER_BIT;

      const lc = this._lastClearColor;
      const { r, g, b, a } = clearColor;
      if (clearColor && (r !== lc.r || g !== lc.g || b !== lc.b || a !== lc.a)) {
        gl.clearColor(r, g, b, a);
        lc.set(r, g, b, a);
      }

      if (targetBlendState.colorWriteMask !== ColorWriteMask.All) {
        gl.colorMask(true, true, true, true);
        targetBlendState.colorWriteMask = ColorWriteMask.All;
      }
    }
    if (clearFlags & CameraClearFlags.Depth) {
      clearFlag |= gl.DEPTH_BUFFER_BIT;
      if (depthState.writeEnabled !== true) {
        gl.depthMask(true);
        depthState.writeEnabled = true;
      }
    }
    if (clearFlags & CameraClearFlags.Stencil) {
      clearFlag |= gl.STENCIL_BUFFER_BIT;
      if (stencilState.writeMask !== 0xff) {
        gl.stencilMask(0xff);
        stencilState.writeMask = 0xff;
      }
    }
    gl.clear(clearFlag);
  }

  drawPrimitive(primitive: Mesh, subPrimitive: SubMesh, shaderProgram: any) {
    // todo: VAO not support morph animation
    if (primitive) {
      //@ts-ignore
      primitive._draw(shaderProgram, subPrimitive);
    } else {
      Logger.error("draw primitive failed.");
    }
  }

  activeRenderTarget(renderTarget: RenderTarget, viewport: Vector4, mipLevel: number) {
    const gl = this._gl;
    if (renderTarget) {
      /** @ts-ignore */
      (renderTarget._platformRenderTarget as GLRenderTarget)?._activeRenderTarget();
      const width = renderTarget.width >> mipLevel;
      const height = renderTarget.height >> mipLevel;
      this.viewport(0, 0, width, height);
      this.scissor(0, 0, width, height);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const { drawingBufferWidth, drawingBufferHeight } = gl;
      const width = drawingBufferWidth * viewport.z;
      const height = drawingBufferHeight * viewport.w;
      const x = viewport.x * drawingBufferWidth;
      const y = drawingBufferHeight - viewport.y * drawingBufferHeight - height;
      this.viewport(x, y, width, height);
      this.scissor(x, y, width, height);
    }
  }

  activeTexture(textureID: number): void {
    if (this._activeTextureID !== textureID) {
      this._gl.activeTexture(textureID);
      this._activeTextureID = textureID;
    }
  }

  bindTexture(texture: GLTexture): void {
    const index = this._activeTextureID - this._gl.TEXTURE0;
    if (this._activeTextures[index] !== texture) {
      this._gl.bindTexture(texture._target, texture._glTexture);
      this._activeTextures[index] = texture;
    }
  }

  setGlobalDepthBias(bias: number, slopeBias: number): void {
    const gl = this._gl;
    const enable = bias !== 0 || slopeBias !== 0;
    if (enable) {
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(slopeBias, bias);
    } else {
      gl.disable(gl.POLYGON_OFFSET_FILL);
    }
    this._enableGlobalDepthBias = enable;
  }

  flush(): void {
    this._gl.flush();
  }

  forceLoseDevice(): void {
    const extension = this.requireExtension(GLCapabilityType.WEBGL_lose_context);
    extension.loseContext();
  }

  forceRestoreDevice(): void {
    const extension = this.requireExtension(GLCapabilityType.WEBGL_lose_context);
    extension.restoreContext();
  }

  resetState(): void {
    this._readFrameBuffer = null;
    this._enableGlobalDepthBias = false;
    this._currentBindShaderProgram = null;

    const activeTextures = this._activeTextures;
    for (let i = 0, n = activeTextures.length; i < n; i++) {
      activeTextures[i] = null;
    }

    this._lastViewport.set(null, null, null, null);
    this._lastScissor.set(null, null, null, null);
    this._lastClearColor.set(null, null, null, null);
    this._scissorEnable = false;

    this._initGLState(this._gl);
  }

  protected _initGLState(gl: (WebGLRenderingContext & WebGLExtension) | WebGL2RenderingContext): void {
    this._activeTextureID = gl.TEXTURE0;
    this._renderStates = new GLRenderStates(gl);
    this._extensions = new GLExtensions(this);
    this._capability = new GLCapability(this);
    // Make sure the active texture in gl context is on default, because gl context may be used in other webgl renderer.
    gl.activeTexture(gl.TEXTURE0);

    const debugRenderInfo = gl.getExtension("WEBGL_debug_renderer_info");
    if (debugRenderInfo != null) {
      this._renderer = gl.getParameter(debugRenderInfo.UNMASKED_RENDERER_WEBGL);
    }
  }

  destroy(): void {
    const webCanvas = this._webCanvas;
    webCanvas.removeEventListener("webglcontextcreationerror", this._onContextCreationError, false);
    webCanvas.removeEventListener("webglcontextlost", this._onWebGLContextLost, false);
    webCanvas.removeEventListener("webglcontextrestored", this._onWebGLContextRestored, false);
  }

  private _onContextCreationError(event: WebGLContextEvent) {
    console.error("WebGLRenderer: WebGL context could not be created. Reason: ", event.statusMessage);
  }

  private _onWebGLContextLost(event: WebGLContextEvent) {
    event.preventDefault();
    this._onDeviceLost();
  }

  private _onWebGLContextRestored(event: WebGLContextEvent) {
    this._onDeviceRestored();
  }
}
