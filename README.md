# ARToolkitX.js
Emscripten port of ARToolKitX to JavaScript.

## Requirements
- Emscripten installed, go to this page for instructions: https://emscripten.org/docs/getting_started/downloads.html
- Cmake
- OpenCV if you want the 2d tracking feature.
- OpenGL

## Build instructions

First open a terminal console and clone this repository:

```shell
git clone https://github.com/augmentmy-world/artoolkitX.js.git
```

Then in the terminal console, enter into the Source folder:

```shell
cd artoolkitX.js/Source
```
If you don't want to build the entire library, you can simply run this command:

```shell
./build.sh
```
The script will download the **artoolkitXjs.zip** file with pre-compiled binaries (artoolkits.js and artoolkit.wasm).

Instead if you want to build the library by yourself, run this command:

```shell
./build.sh --dev
```

The build process should start, after some checks you will asked if you want to clone the [ArtoolkitX](https://github.com/augmentmy-world/artoolkitx) project inside artoolkitX.js:

 ```shell
Would you like to clone the submodule (recommended) y/n
```

Choose **y** (yes) if you want to clone and save it inside the `Source/extra` folder or you can choose **n** (no) if you have already it in another location. In this case you must set up the **ARTOOLKITX_HOME** env variable.

As Cmake will finish the configure process and generate the makefiles, the real build process will begin and in few minutes the `artoolkitx.js` `artoolkitx.wasm` libs will be ready.

## Examples
Go into the Examples folder, start a http server and test them. For now try:

- test.html
- simple_image.html
- simple_video.html
- simple_video_hiro.html
- simple_video-multi-barcode.html
- simple_video-multi-patt.html

## Author
**Thorsten Bux** https://github.com/ThorstenBux

### Collaborators:
**Walter Perdan** https://github.com/kalwalt

## OS tested
Tested under Ubuntu 18.04 and macOS.
