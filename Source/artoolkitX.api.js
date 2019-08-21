import artoolkitXjs from "./artoolkitx.js";
(function () {
    "use strict";

    /**
          The ARController is the main object for doing augmented reality with artoolkitX.js.

          To use an ARController, you need to tell which image or video stream to use and
          pass it an ARCameraParam object to define the camera parameters to use during processing.
          The ARCameraParam defines the lens distortion and aspect ratio of the camera used.
          See https://github.com/artoolkitx/artoolkitx/wiki/Using-the-artoolkitX-distributed-camera-calibration-system for more information.

          The dimensions of the image that you pass in as the first argument are used as AR processing canvas width and height.

          The camera parameters argument is an URL to a camera definition file which immediately returns a Promise which resolves into a useable URL string.

          @exports ARController
          @constructor

          @param {HTMLImageElement | HTMLVideoElement} image The ARController treats it as an image and it tries to find a marker in that image
          @param {string}  cameraPara A string to the camera para to use for image processing.
      */
    var ARController = function (image, cameraPara) {
        this.orientation = "landscape";
        this.listeners = {};
        this._patternDetection = {};

        this.image = image;

        if (this.image) {
            if(this.image.srcObject) {
                const videoTrack = image.srcObject.getVideoTracks()[0];
                if(videoTrack) {
                    const videoTrackSettings = videoTrack.getSettings();
                    this.videoWidth = videoTrackSettings.width;
                    this.videoHeight = videoTrackSettings.height;
                }
            } else {
                this.videoWidth = image.videoWidth || image.width;
                this.videoHeight = image.videoHeight || image.height;
            }
            this.canvas = document.createElement("canvas");
            this.canvas.width = this.videoWidth;
            this.canvas.height = this.videoHeight;
            this.ctx = this.canvas.getContext("2d");
        } else {
            throw "No image/video provided you need to pass either a HTMLImageElement or HTMLVideoElement to the constructor";
        }

        this.defaultMarkerWidth = 80;
        this.trackables = new Array();
        this.transform_mat = new Float64Array(16);
        this.videoSize = this.videoWidth * this.videoHeight;

        this.count = 0;

        //debugging
        this._lumaCtx = undefined;
        this.cameraParaFileURL = cameraPara;
        this.debug = false;
    };

    ARController.prototype.start = async function () {
        var success = artoolkitXjs.initialiseAR();
        if (success) {
            console.log("Version: " + artoolkitXjs.getARToolKitVersion());
            //Only try to load the camera parameter file if an URL was provided
            let arCameraURL = "";
            if (this.cameraParaFileURL !== "") {
                try {
                    arCameraURL = await ARController[_loadCameraParam](this.cameraParaFileURL)
                } catch (e) {
                    //Clean up video which might already be open
                    this.dispose();
                    throw "Error loading camera param: " + e;
                }
            }
            success = artoolkitXjs.arwStartRunningJS(
                arCameraURL,
                this.videoWidth,
                this.videoHeight
            );
            if (success >= 0) {
                console.info("artoolkitX started");
                success = artoolkitXjs.pushVideoInit(
                    0,
                    this.videoWidth,
                    this.videoHeight,
                    "RGBA",
                    0,
                    0
                );
                if (success < 0) {
                    throw "Error while starting";
                }
            } else throw "Error while starting";
        } else {
            throw "Error while starting";
        }
    };

    /**
          Destroys the ARController instance and frees all associated resources.
          After calling dispose, the ARController can't be used any longer. Make a new one if you need one.

          Calling this avoids leaking Emscripten memory.
      */
    ARController.prototype.dispose = function () {
        artoolkitXjs._free(this._transMatPtr);
        if (this.image && this.image.srcObject) {
            ARController._teardownVideo(this.image);
        }
        artoolkitXjs.stopRunning();
        artoolkitXjs.shutdownAR();

        for (var t in this) {
            this[t] = null;
        }
    };

    // TODO: MultiMarker and events
    /**
          Detects markers in the given image. The process method dispatches marker detection events during its run.

          The marker detection process proceeds by first dispatching a markerNum event that tells you how many
          markers were found in the image. Next, a getMarker event is dispatched for each found marker square.
          Finally, getMultiMarker is dispatched for every found multimarker, followed by getMultiMarkerSub events
          dispatched for each of the markers in the multimarker.

          If no image is given, defaults to this.image.
          @param {HTMLImageElement|HTMLVideoElement} [image] The image to process [optional].
      */
    ARController.prototype.process = async function (image) {
        if (!image) image = this.image;

        if (!artoolkitXjs.isInitialized()) {
            try {
                await this.start();
            } catch (e) {
                console.error("Unable to start running");
            }
        }

        try {
            this._prepareImage(image);
            var success = artoolkitXjs.updateAR();

            if (success >= 0) {
                this.trackables.forEach(function (trackable) {
                    var transformation = this._queryTrackableVisibility(
                        trackable.trackableId
                    );
                    if (transformation) {
                        trackable.transformation = transformation;
                        trackable.visible = true;
                        this.dispatchEvent({
                            name: "getMarker",
                            target: this,
                            data: trackable
                        });
                    } else {
                        trackable.visible = false;
                        console.debug(`Trackable ${trackable.trackableId} not visible`);
                    }
                }, this);
            }
        } catch (e) {
            console.error("Unable to detect marker: " + e);
        }
    };

    //TODO: implement MultiMarkerEvents
    /**
          Add an event listener on this ARController for the named event, calling the callback function
          whenever that event is dispatched.

          Possible events are:
          * getMarker - dispatched whenever process() finds a square marker
          * getMultiMarker - dispatched whenever process() finds a visible registered multimarker
          * getMultiMarkerSub - dispatched by process() for each marker in a visible multimarker

          @param {string} name Name of the event to listen to.
          @param {function} callback Callback function to call when an event with the given name is dispatched.
      */
    ARController.prototype.addEventListener = function (name, callback) {
        if (!this.listeners[name]) {
            this.listeners[name] = [];
        }
        this.listeners[name].push(callback);
    };

    /**
          Remove an event listener from the named event.

          @param {string} name Name of the event to stop listening to.
          @param {function} callback Callback function to remove from the listeners of the named event.
      */
    ARController.prototype.removeEventListener = function (name, callback) {
        if (this.listeners[name]) {
            var index = this.listeners[name].indexOf(callback);
            if (index > -1) {
                this.listeners[name].splice(index, 1);
            }
        }
    };

    /**
          Dispatches the given event to all registered listeners on event.name.

          @param {Object} event Event to dispatch.
      */
    ARController.prototype.dispatchEvent = function (event) {
        var listeners = this.listeners[event.name];
        if (listeners) {
            for (var i = 0; i < listeners.length; i++) {
                listeners[i].call(this, event);
            }
        }
    };

    // /**
    // 	Sets up a debug canvas for the AR detection. Draws a red marker on top of each detected square in the image.

    // 	The debug canvas is added to document.body.
    // */
    ARController.prototype.debugSetup = function () {
        document.body.appendChild(this.canvas);

        var lumaCanvas = document.createElement("canvas");
        lumaCanvas.width = this.canvas.width;
        lumaCanvas.height = this.canvas.height;
        this._lumaCtx = lumaCanvas.getContext("2d");
        document.body.appendChild(lumaCanvas);
        this.enableDebugMode(true);
    };

    /**
     * Loads a trackable into the artoolkitX contect by calling addTrackable on the artoolkitX native interface
     *
     * @param {object} trackableObj -
     *              {
     *                  trackableType:  {string} 'single_barcode' / 'multi' / 'single' / '2D'
     *                  url: {string} '<URL to the trackable file in case of multi, single or 2D>'
     *                  barcodeId: {number}
     *                  width: {number} defaults to this.markerWidth if not set
     *              }
     */

    ARController.prototype.addTrackable = async function (trackableObj) {
        if (!trackableObj.width) trackableObj.width = this.defaultMarkerWidth;
        var fileName, trackableId;
        if (trackableObj.trackableType.includes("single")) {
            if (trackableObj.barcodeId != undefined) {
                fileName = trackableObj.barcodeId;
                if (!this._patternDetection.barcode) {
                    this._patternDetection.barcode = true;
                }
            } else {
                try {
                    fileName = await ARController[_loadTrackable](trackableObj.url)
                } catch (e) {
                    throw "Error to load trackable: " + e;
                }
                if (!this._patternDetection.template) {
                    this._patternDetection.template = true;
                }
            }
            trackableId = artoolkitXjs.addTrackable(
                trackableObj.trackableType + ";" + fileName + ";" + trackableObj.width
            );
        } else if (trackableObj.trackableType === "multi") {
            fileName = await ARController[_loadMultiTrackable](trackableObj.url)
            trackableId = artoolkitXjs.addTrackable(
                `${trackableObj.trackableType};${fileName}`
            );
        }

        if (trackableId >= 0) {
            this.trackables.push({
                trackableId: trackableId,
                transformation: new Array(),
                visible: false
            });
            if (!this.userSetPatternDetection) this._updateDetectionMode();
            return trackableId;
        }
        throw "Faild to add Trackable: " + trackableId;
    };

    /**
     * Populates the provided float array with the current transformation for the specified marker. After
     * a call to detectMarker, all marker information will be current. Marker transformations can then be
     * checked.
     * @param {number} trackableUID	The unique identifier (UID) of the marker to query
     * @return	{Float32Array} The dst array.
     */

    ARController.prototype.getTransMatSquare = function (trackableUID) {
        return this._queryTrackableVisibility(trackableUID);
    };

    // /**
    //  * T.B.: Make this function static as it is a util function and doesn't manipulate the ARController object (this)
    //  *
    // 	Converts the given 3x4 marker transformation matrix in the 12-element transMat array
    // 	into a 4x4 WebGL matrix and writes the result into the 16-element glMat array.

    // 	If scale parameter is given, scales the transform of the glMat by the scale parameter.

    // 	@param {Float64Array} transMat The 3x4 marker transformation matrix.
    // 	@param {Float64Array} glMat The 4x4 GL transformation matrix.
    // 	@param {number} [scale] The scale for the transform.
    // */
    // ARController.transMatToGLMat = function(transMat, glMat, scale) {
    //     if(glMat == undefined){
    //         glMat = new Float64Array(16);
    //     }
    // 	glMat[0 + 0*4] = transMat[0]; // R1C1
    // 	glMat[0 + 1*4] = transMat[1]; // R1C2
    // 	glMat[0 + 2*4] = transMat[2];
    // 	glMat[0 + 3*4] = transMat[3];
    // 	glMat[1 + 0*4] = transMat[4]; // R2
    // 	glMat[1 + 1*4] = transMat[5];
    // 	glMat[1 + 2*4] = transMat[6];
    // 	glMat[1 + 3*4] = transMat[7];
    // 	glMat[2 + 0*4] = transMat[8]; // R3
    // 	glMat[2 + 1*4] = transMat[9];
    // 	glMat[2 + 2*4] = transMat[10];
    // 	glMat[2 + 3*4] = transMat[11];
    // 	glMat[3 + 0*4] = 0.0;
    // 	glMat[3 + 1*4] = 0.0;
    // 	glMat[3 + 2*4] = 0.0;
    // 	glMat[3 + 3*4] = 1.0;
    // 	if (scale != undefined && scale !== 0.0) {
    // 		glMat[12] *= scale;
    // 		glMat[13] *= scale;
    // 		glMat[14] *= scale;
    // 	}
    // 	return glMat;
    // };

    // /**
    //  * T.B.: Make this function static as it is a util function and doesn't manipulate the ARController object (this)

    // 	Converts the given 4x4 openGL matrix in the 16-element transMat array
    // 	into a 4x4 OpenGL Right-Hand-View matrix and writes the result into the 16-element glMat array.

    // 	If scale parameter is given, scales the transform of the glMat by the scale parameter.

    // 	@param {Float64Array} glMatrix The 4x4 marker transformation matrix.
    // 	@param {Float64Array} [glRhMatrix] The 4x4 GL right hand transformation matrix.
    // 	@param {number} [scale] The scale for the transform.
    // */
    // ARController.arglCameraViewRHf = function(glMatrix, glRhMatrix, scale)
    // {
    //     var m_modelview;
    //     if(glRhMatrix == undefined)
    //         m_modelview = new Float64Array(16);
    //     else
    //         m_modelview = glRhMatrix;

    //     // x
    //     m_modelview[0] = glMatrix[0];
    //     m_modelview[4] = glMatrix[4];
    //     m_modelview[8] = glMatrix[8];
    //     m_modelview[12] = glMatrix[12];
    //     // y
    //     m_modelview[1] = -glMatrix[1];
    //     m_modelview[5] = -glMatrix[5];
    //     m_modelview[9] = -glMatrix[9];
    //     m_modelview[13] = -glMatrix[13];
    //     // z
    //     m_modelview[2] = -glMatrix[2];
    //     m_modelview[6] = -glMatrix[6];
    //     m_modelview[10] = -glMatrix[10];
    //     m_modelview[14] = -glMatrix[14];

    //     // 0 0 0 1
    //     m_modelview[3] = 0;
    //     m_modelview[7] = 0;
    //     m_modelview[11] = 0;
    //     m_modelview[15] = 1;

    //     if (scale != undefined && scale !== 0.0) {
    // 		m_modelview[12] *= scale;
    // 		m_modelview[13] *= scale;
    // 		m_modelview[14] *= scale;
    // 	}

    //     glRhMatrix = m_modelview;

    //     return glRhMatrix;
    // }

    //FIX
    // /**
    // 	Get the number of markers detected in a video frame.

    //     @return {number}     The number of detected markers in the most recent image passed to arDetectMarker.
    // 	    Note that this is actually a count, not an index. A better name for this function would be
    //     	arGetDetectedMarkerCount, but the current name lives on for historical reasons.
    // */
    // ARController.prototype.getMarkerNum = function() {
    // 	return artoolkit.getMarkerNum(this.id);
    // };

    /**
     * Returns the projection matrix computed from camera parameters for the ARController.
     *
     * @return {Float32Array} The 16-element WebGL camera matrix for the ARController camera parameters.
     */
    ARController.prototype.getCameraMatrix = function (nearPlane, farPlane) {
        return artoolkitXjs._arwGetProjectionMatrix(nearPlane, farPlane);
    };

    /* Setter / Getter Proxies */

    /**
     * Enables or disables debug mode in the tracker. When enabled, a black and white debug
     * image is generated during marker detection. The debug image is useful for visualising
     * the binarization process and choosing a threshold value.
     * @param {boolean} enable  true to enable debug mode, false to disable debug mode
     * @see	enableDebugMode()
     */
    ARController.prototype.enableDebugMode = function (enable) {
        this.debug = true;
        return artoolkitXjs.setTrackerOptionBool(
            artoolkitXjs.TrackableOptions.ARW_TRACKER_OPTION_SQUARE_DEBUG_MODE.value,
            enable
        );
    };

    /**
     * Returns whether debug mode is currently enabled.
     * @return {boolean}	true when debug mode is enabled, false when debug mode is disabled
     * @see					setDebugMode()
     */
    ARController.prototype.isDebugMode = function () {
        return artoolkitXjs.getTrackerOptionBool(
            artoolkitXjs.TrackableOptions.ARW_TRACKER_OPTION_SQUARE_DEBUG_MODE.value
        );
    };

    /**
       * Sets the logging level to use by ARToolKit.
       *
       * @param mode      {@see https://github.com/artoolkitx/artoolkitx/Source/artoolkitx.js/ARX_bindings.cpp} -> ARLogLevel
                           Which is represented in JS as artoolkitXjs.ARLogLevel.[Option]
       */
    ARController.prototype.setLogLevel = function (mode) {
        this.debugSetup();
        return artoolkitXjs.setLogLevel(mode);
    };

    /**
     * Returns the current log level
     * @returns {number}    The current loglevel as set in {@link #setLogLevel} defaults to artoolkitXjs.arLogLevel.AR_LOG_LEVEL_INFO
     */
    ARController.prototype.getLogLevel = function () {
        return artoolkitXjs.getLogLevel();
    };

    /**
          Set the labeling threshold mode (auto/manual).

          @param {number}	    mode An integer specifying the mode. One of:
              artoolkitXjs.LabelingThresholdMode.AR_LABELING_THRESH_MODE_MANUAL,
              artoolkitXjs.LabelingThresholdMode.AR_LABELING_THRESH_MODE_AUTO_MEDIAN,
              artoolkitXjs.LabelingThresholdMode.AR_LABELING_THRESH_MODE_AUTO_OTSU,
              artoolkitXjs.LabelingThresholdMode.AR_LABELING_THRESH_MODE_AUTO_ADAPTIVE,
              artoolkitXjs.LabelingThresholdMode.AR_LABELING_THRESH_MODE_AUTO_BRACKETING
              {@see https://github.com/artoolkitx/artoolkitx/Source/artoolkitx.js/ARX_bindings.cpp} -> LabelingThresholdMode
      */
    ARController.prototype.setThresholdMode = function (mode) {
        artoolkitXjs.setTrackerOptionInt(
            artoolkitXjs.TrackableOptions.ARW_TRACKER_OPTION_SQUARE_THRESHOLD_MODE
                .value,
            mode
        );
    };

    /**
     * Gets the current threshold mode used for image binarization.
     * @return  {number}        The current threshold mode
     * @see     getVideoThresholdMode()
     */
    ARController.prototype.getThresholdMode = function () {
        return artoolkitXjs.getTrackerOptionInt(
            artoolkitXjs.TrackableOptions.ARW_TRACKER_OPTION_SQUARE_THRESHOLD_MODE
                .value
        );
    };

    /**
          Set the labeling threshhold.

          This function forces sets the threshold value.
          The default value is AR_DEFAULT_LABELING_THRESH which is 100.

          The current threshold mode is not affected by this call.
          Typically, this function is used when labeling threshold mode
          is AR_LABELING_THRESH_MODE_MANUAL.

          The threshold value is not relevant if threshold mode is
          AR_LABELING_THRESH_MODE_AUTO_ADAPTIVE.

          Background: The labeling threshold is the value which
          the AR library uses to differentiate between black and white
          portions of an ARToolKit marker. Since the actual brightness,
          contrast, and gamma of incoming images can vary signficantly
          between different cameras and lighting conditions, this
          value typically needs to be adjusted dynamically to a
          suitable midpoint between the observed values for black
          and white portions of the markers in the image.

          @param {number}     threshold An integer in the range [0,255] (inclusive).
      */
    ARController.prototype.setThreshold = function (threshold) {
        artoolkitXjs.setTrackerOptionInt(
            artoolkitXjs.TrackableOptions.ARW_TRACKER_OPTION_SQUARE_THRESHOLD,
            threshold
        );
    };

    /**
          Get the current labeling threshold.

          This function queries the current labeling threshold. For,
          AR_LABELING_THRESH_MODE_AUTO_MEDIAN, AR_LABELING_THRESH_MODE_AUTO_OTSU,
          and AR_LABELING_THRESH_MODE_AUTO_BRACKETING
          the threshold value is only valid until the next auto-update.

          The current threshold mode is not affected by this call.

          The threshold value is not relevant if threshold mode is
          AR_LABELING_THRESH_MODE_AUTO_ADAPTIVE.

          @return {number} The current threshold value.
      */
    ARController.prototype.getThreshold = function () {
        return artoolkitXjs.getTrackerOptionInt(
            artoolkitXjs.TrackableOptions.ARW_TRACKER_OPTION_SQUARE_THRESHOLD
        );
    };

    /**
          Set the pattern detection mode

          The pattern detection determines the method by which ARToolKit
          matches detected squares in the video image to marker templates
          and/or IDs. ARToolKit v4.x can match against pictorial "template" markers,
          whose pattern files are created with the mk_patt utility, in either colour
          or mono, and additionally can match against 2D-barcode-type "matrix"
          markers, which have an embedded marker ID. Two different two-pass modes
          are also available, in which a matrix-detection pass is made first,
          followed by a template-matching pass.

          @param {number} mode
              Options for this field are:
              artoolkitXjs.AR_TEMPLATE_MATCHING_COLOR
              artoolkitXjs.AR_TEMPLATE_MATCHING_MONO
              artoolkitXjs.AR_MATRIX_CODE_DETECTION
              artoolkitXjs.AR_TEMPLATE_MATCHING_COLOR_AND_MATRIX
              artoolkitXjs.AR_TEMPLATE_MATCHING_MONO_AND_MATRIX
              artoolkitXjs.The default mode is AR_TEMPLATE_MATCHING_COLOR.
      */
    ARController.prototype.setPatternDetectionMode = function (mode) {
        this.userSetPatternDetection = true;
        return this._setPatternDetectionMode(mode);
    };

    /**
          Returns the current pattern detection mode.
          @return {number} The current pattern detection mode. {@see https://github.com/artoolkitx/artoolkitx/Source/artoolkitx.js/ARX_bindings.cpp} -> arPatternDetectionMode
                           Which is represented in JS as artoolkitXjs.[Mode]
      */
    ARController.prototype.getPatternDetectionMode = function () {
        return artoolkitXjs.getTrackerOptionInt(
            artoolkitXjs.TrackableOptions
                .ARW_TRACKER_OPTION_SQUARE_PATTERN_DETECTION_MODE.value
        );
    };

    /**
          Set the size and ECC algorithm to be used for matrix code (2D barcode) marker detection.

          When matrix-code (2D barcode) marker detection is enabled (see arSetPatternDetectionMode)
          then the size of the barcode pattern and the type of error checking and correction (ECC)
          with which the markers were produced can be set via this function.

          This setting is global to a given ARHandle; It is not possible to have two different matrix
          code types in use at once.

          @param      type The type of matrix code (2D barcode) in use. Options include:
              artoolkitXjs.ARMatrixCodeType.AR_MATRIX_CODE_3x3
              artoolkitXjs.ARMatrixCodeType.AR_MATRIX_CODE_3x3_HAMMING63
              artoolkitXjs.ARMatrixCodeType.AR_MATRIX_CODE_3x3_PARITY65
              artoolkitXjs.ARMatrixCodeType.AR_MATRIX_CODE_4x4
              artoolkitXjs.ARMatrixCodeType.AR_MATRIX_CODE_4x4_BCH_13_9_3
              artoolkitXjs.ARMatrixCodeType.AR_MATRIX_CODE_4x4_BCH_13_5_5
              The default mode is artoolkitXjs.ARMatrixCodeType.AR_MATRIX_CODE_3x3.
              {@see https://github.com/artoolkitx/artoolkitx/Source/artoolkitx.js/ARX_bindings.cpp} -> ARMatrixCodeType
      */
    ARController.prototype.setMatrixCodeType = function (type) {
        artoolkitXjs.setTrackerOptionInt(
            artoolkitXjs.TrackableOptions.ARW_TRACKER_OPTION_SQUARE_MATRIX_CODE_TYPE
                .value,
            type
        );
    };

    /**
          Returns the current matrix code (2D barcode) marker detection type.

          @return {number} The current matrix code type. {@link setMatrixCodeType}
      */
    ARController.prototype.getMatrixCodeType = function () {
        return artoolkitXjs.getTrackerOptionInt(
            artoolkitXjs.TrackableOptions.ARW_TRACKER_OPTION_SQUARE_MATRIX_CODE_TYPE
                .value
        );
    };

    /**
          Select between detection of black markers and white markers.

          ARToolKit's labelling algorithm can work with both black-bordered
          markers on a white background (AR_LABELING_BLACK_REGION) or
          white-bordered markers on a black background (AR_LABELING_WHITE_REGION).
          This function allows you to specify the type of markers to look for.
          Note that this does not affect the pattern-detection algorith
          which works on the interior of the marker.

          @param {number}      mode
              Options for this field are:
              artoolkitXjs.AR_LABELING_WHITE_REGION
              artoolkitXjs.AR_LABELING_BLACK_REGION
              The default mode is AR_LABELING_BLACK_REGION.
      */
    ARController.prototype.setLabelingMode = function (mode) {
        artoolkitXjs.setTrackerOptionInt(
            artoolkitXjs.TrackableOptions.ARW_TRACKER_OPTION_SQUARE_LABELING_MODE,
            mode
        );
    };

    /**
          Enquire whether detection is looking for black markers or white markers.
          See {@link #setLabelingMode}

          @result {number} The current labeling mode see {@link setLabelingMode}.
      */
    ARController.prototype.getLabelingMode = function () {
        return artoolkitXjs.getTrackerOptionInt(
            artoolkitXjs.TrackableOptions.ARW_TRACKER_OPTION_SQUARE_LABELING_MODE
        );
    };

    /**
          Set the width/height of the marker pattern space, as a proportion of marker width/height.

          @param {number}     pattRatio The the width/height of the marker pattern space, as a proportion of marker
              width/height. To set the default, pass artoolkitXjs.AR_PATT_RATIO.
      */
    ARController.prototype.setPattRatio = function (pattRatio) {
        artoolkitXjs.setTrackerOptionFloat(
            artoolkitXjs.TrackableOptions.ARW_TRACKER_OPTION_SQUARE_BORDER_SIZE,
            pattRatio
        );
    };

    /**
          Returns the current ratio of the marker pattern to the total marker size.

          @return {number} The current pattern ratio.
      */
    ARController.prototype.getPattRatio = function () {
        return artoolkitXjs.getTrackerOptionFloat(
            artoolkitXjs.TrackableOptions.ARW_TRACKER_OPTION_SQUARE_BORDER_SIZE
        );
    };

    /**
          Set the image processing mode.

          When the image processing mode is AR_IMAGE_PROC_FRAME_IMAGE,
          artoolkitX processes all pixels in each incoming image
          to locate markers. When the mode is AR_IMAGE_PROC_FIELD_IMAGE,
          artoolkitX processes pixels in only every second pixel row and
          column. This is useful both for handling images from interlaced
          video sources (where alternate lines are assembled from alternate
          fields and thus have one field time-difference, resulting in a
          "comb" effect) such as Digital Video cameras.
          The effective reduction by 75% in the pixels processed also
          has utility in accelerating tracking by effectively reducing
          the image size to one quarter size, at the cost of pose accuraccy.

          @param {number} mode
              Options for this field are:
              artoolkitXjs.AR_IMAGE_PROC_FRAME_IMAGE
              artoolkitXjs.AR_IMAGE_PROC_FIELD_IMAGE
              The default mode is artoolkitXjs.AR_IMAGE_PROC_FRAME_IMAGE.
      */
    ARController.prototype.setImageProcMode = function (mode) {
        artoolkitXjs.setTrackerOptionInt(
            artoolkitXjs.TrackableOptions.ARW_TRACKER_OPTION_SQUARE_IMAGE_PROC_MODE,
            mode
        );
    };

    /**
          Get the image processing mode.
          See {@link #setImageProcMode} for a complete description.

          @return {number} The current image processing mode.
      */
    ARController.prototype.getImageProcMode = function () {
        return artoolkitXjs.getTrackerOptionInt(
            artoolkitXjs.TrackableOptions.ARW_TRACKER_OPTION_SQUARE_IMAGE_PROC_MODE
        );
    };

    /**
          Draw the black and white image and debug markers to the ARController canvas.

          See setDebugMode.
      */
     ARController.prototype.debugDraw = function () {
         // var debugBuffer = new Uint8ClampedArray(Module.HEAPU8.buffer, this._bwpointer, this.framesize);
         // var id = new ImageData(debugBuffer, this.videoWidth, this.videoHeight);
         // this.ctx.putImageData(id, 0, 0);

        //Debug Luma
        var lumaBuffer = new Uint8ClampedArray(this.framesize);
        lumaBuffer.set(this.videoLuma);
        var lumaImageData = new ImageData(
            lumaBuffer,
            this.videoWidth,
            this.videoHeight
        );
        this._lumaCtx.putImageData(lumaImageData, 0, 0);

        this.trackables.forEach(trackable => {
            if (trackable.visible) {
                console.debug(
                    `Trackable ${trackable.trackableId} visible; Matrix: ${
                    trackable.transformation
                    }`
                );
            } else {
                console.debug(`Trackable ${trackable.trackableId} not visible`);
            }
        });
    };

    // private

    /**
     * Sets imageData and videoLuma as properties to ARController object to be used for marker detection.
     * Copies the video image and luma buffer into the HEAP to be available for the compiled C code for marker detection.
     * Sets newFrame and fillFlag in the compiled C code to signal the marker detection that a new frame is available.
     *
     * @param {HTMLImageElement|HTMLVideoElement} [image] The image to prepare for marker detection
     * @returns {boolean} true if successfull
     * @private
     */
    ARController.prototype._prepareImage = function (image) {
        if (!image) {
            image = this.image;
        }

        this.ctx.save();

        if (this.orientation === "portrait") {
            this.ctx.translate(this.canvas.width, 0);
            this.ctx.rotate(Math.PI / 2);
            this.ctx.drawImage(image, 0, 0, this.canvas.height, this.canvas.width); // draw video
        } else {
            this.ctx.drawImage(image, 0, 0, this.canvas.width, this.canvas.height); // draw video
        }

        this.ctx.restore();

        var imageData = this.ctx.getImageData(
            0,
            0,
            this.canvas.width,
            this.canvas.height
        );
        var data = imageData.data; // this is of type Uint8ClampedArray: The Uint8ClampedArray typed array represents an array of 8-bit unsigned integers clamped to 0-255 (https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Uint8ClampedArray)

        //Here we have access to the unmodified video image. We now need to add the videoLuma chanel to be able to serve the underlying ARTK API
        var q = 0;
        var videoLuma = new Uint8ClampedArray(data.length / 4);
        //Create luma from video data assuming Pixelformat AR_PIXEL_FORMAT_RGBA (ARToolKitJS.cpp L: 43)

        for (var p = 0; p < this.videoSize; p++) {
            var r = data[q + 0],
                g = data[q + 1],
                b = data[q + 2];
            // videoLuma[p] = (r+r+b+g+g+g)/6;         // https://stackoverflow.com/a/596241/5843642
            videoLuma[p] = (r + r + r + b + g + g + g + g) >> 3;
            q += 4;
        }

        this.imageData = data;
        this.videoLuma = videoLuma;

        //Copy image data into HEAP. HEAP was prepared during videoWeb.c::ar2VideoPushInitWeb()
        var videoMalloc = artoolkitXjs.videoMalloc;
        var videoFrameBytes = new Uint8Array(
            artoolkitXjs.HEAPU8.buffer,
            videoMalloc.framepointer,
            videoMalloc.framesize
        );
        videoFrameBytes.set(data);
        this.framesize = videoMalloc.framesize;

        //Copy luma image
        var videoFrameLumaBytes = new Uint8Array(
            artoolkitXjs.HEAPU8.buffer,
            videoMalloc.lumaFramePointer,
            videoMalloc.framesize / 4
        );
        videoFrameLumaBytes.set(videoLuma);

        artoolkitXjs.setValue(videoMalloc.newFrameBoolPtr, 1, "i8");
        artoolkitXjs.setValue(videoMalloc.fillFlagIntPtr, 1, "i32");

        //Provide a timestamp to each frame because arvideo2.arUtilTimeSinceEpoch() seems not to perform well with Emscripten.
        //It internally calls gettimeofday which should not be used with Emscripten according to this: https://github.com/urho3d/Urho3D/issues/916
        //which says that emscripten_get_now() should be used. However, this seems to have issues too https://github.com/kripken/emscripten/issues/5893
        //Basically because it relies on performance.now() and performance.now() is supposedly slower then Date.now() but offers greater accuracy.
        //Or rather should offer but does not anymore because of Spectre (https://en.wikipedia.org/wiki/Spectre_(security_vulnerability))
        //Bottom line as performance.now() is slower then Date.now() (https://jsperf.com/gettime-vs-now-0/7) and doesn't offer higher accuracy and we
        //would be calling it for each video frame I decided to read the time per frame from JS and pass it in to the compiled C-Code using a pointer.
        const time = Date.now();
        const seconds = Math.floor(time / 1000);
        const milliSeconds = time - seconds * 1000;
        artoolkitXjs.setValue(videoMalloc.timeSecPtr, seconds, "i32");
        artoolkitXjs.setValue(videoMalloc.timeMilliSecPtr, milliSeconds, "i32");

        var ret = artoolkitXjs._arwCapture();

        if (this.debug) {
            this.debugDraw();
        }

        return ret;
    };

    // Internal wrapper to _arwQueryTrackableVisibilityAndTransformation to avoid ccall overhead
    ARController.prototype._queryTrackableVisibility = function (trackableId) {
        var transformationMatrixElements = 16;
        var numBytes =
            transformationMatrixElements * Float32Array.BYTES_PER_ELEMENT;
        this._transMatPtr = artoolkitXjs._malloc(numBytes);
        // Call compiled C-function directly using '_' notation
        // https://kripken.github.io/emscripten-site/docs/porting/connecting_cpp_and_javascript/Interacting-with-code.html#interacting-with-code-direct-function-calls
        var transformation = artoolkitXjs._arwQueryTrackableVisibilityAndTransformation(
            trackableId,
            this._transMatPtr
        );
        var matrix = new Float32Array(
            artoolkitXjs.HEAPU8.buffer,
            this._transMatPtr,
            transformationMatrixElements
        );
        if (transformation) {
            return matrix;
        }
        return undefined;
    };

    /**
     * Private function to set the pattenr detection mode.
     * It is implemented like this to have the posibility to let the user set the pattern detection mode
     * by still providing the automatism to allow to set the pattern detection mode depending on the registered trackables (see {@link #addTrackable}).
     * @param {*} mode see {@link #setPatternDetectionMode}
     */
    ARController.prototype._setPatternDetectionMode = function (mode) {
        return artoolkitXjs.setTrackerOptionInt(
            artoolkitXjs.TrackableOptions
                .ARW_TRACKER_OPTION_SQUARE_PATTERN_DETECTION_MODE.value,
            mode
        );
    };

    /**
     * For ease of use check what kinds of markers have been added and set the detection mode accordingly
     */
    ARController.prototype._updateDetectionMode = function () {
        if (this._patternDetection.barcode && this._patternDetection.template) {
            this._setPatternDetectionMode(
                artoolkitXjs.AR_TEMPLATE_MATCHING_COLOR_AND_MATRIX
            );
        } else if (this._patternDetection.barcode) {
            this._setPatternDetectionMode(artoolkitXjs.AR_MATRIX_CODE_DETECTION);
        } else {
            this._setPatternDetectionMode(artoolkitXjs.AR_TEMPLATE_MATCHING_COLOR);
        }
    };

    /**
     * Properly end the video stream
     * @param {HTMLVideoElement} video The video to stop
     */
    ARController._teardownVideo = function (video) {
        video.srcObject.getVideoTracks()[0].stop();
        video.srcObject = null;
        video.src = null;
    };

 /**
 * Defining private statics
 */
const _ajax = Symbol('_ajax')
const _loadTrackable = Symbol('_loadTrackable')
const _loadCameraParam = Symbol('_loadCameraParam')
const _loadMultiTrackable = Symbol('_loadMultiTrackable')
const _ajaxDependencies = Symbol('_ajaxDependencies')
const _parseMultiFile = Symbol('_parseMultiFile')

    // Eg.
    //  ajax('../bin/Data2/markers.dat', '/Data2/markers.dat', callback);
    //  ajax('../bin/Data/patt.hiro', '/patt.hiro', callback);
    // Promise enabled: https://stackoverflow.com/a/48969580/5843642
    ARController[_ajax] = (url, target) => {
        return new Promise((resolve, reject) => {
            var oReq = new XMLHttpRequest();
            oReq.open("GET", url, true);
            oReq.responseType = "arraybuffer"; // blob arraybuffer

            oReq.onload = function () {
                if (this.status == 200) {
                    // console.log('ajax done for ', url);
                    var arrayBuffer = oReq.response;
                    var byteArray = new Uint8Array(arrayBuffer);
                    artoolkitXjs.FS.writeFile(target, byteArray, { encoding: "binary" });
                    resolve(byteArray);
                } else {
                    reject(this.status);
                }
            };
            oReq.send();
        });
    }

    // static

    /**
          ARController.getUserMedia gets a device camera video feed and returns a Promis that will resolve in a {@link HTMLVideoElement}.

          Tries to start playing the video. Playing the video can fail, if so an exception will be thown.

          The configuration object supports the following attributes:

              {
                  width : number | {min: number, max: number},
                  height : number | {min: number, max: number},

                  facingMode : 'environment' | 'user' | 'left' | 'right' | { exact: 'environment' | ... }
                  deviceId : string | {exact: 'string'}
              }

          See https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia for more information about the
          width, height and facingMode attributes.

          @param {object} configuration The configuration object.
          @return {HTMLVideoElement} Returns the created video element.
      */
    ARController.getUserMedia = async function (configuration) {
        const facing = configuration.facingMode || "environment";
        const video = document.createElement("video");

        const constraints = {};
        const mediaDevicesConstraints = {};
        if (configuration.width) {
            mediaDevicesConstraints.width = configuration.width;
            if (typeof configuration.width === "object") {
                if (configuration.width.max) {
                    constraints.maxWidth = configuration.width.max;
                }
                if (configuration.width.min) {
                    constraints.minWidth = configuration.width.min;
                }
            } else {
                constraints.maxWidth = configuration.width;
            }
        }

        if (configuration.height) {
            mediaDevicesConstraints.height = configuration.height;
            if (typeof configuration.height === "object") {
                if (configuration.height.max) {
                    constraints.maxHeight = configuration.height.max;
                }
                if (configuration.height.min) {
                    constraints.minHeight = configuration.height.min;
                }
            } else {
                constraints.maxHeight = configuration.height;
            }
        }

        mediaDevicesConstraints.facingMode = facing;
        mediaDevicesConstraints.deviceId = configuration.deviceId;

        var readyToPlay = false;
        var eventNames = [
            "touchstart",
            "touchend",
            "touchmove",
            "touchcancel",
            "click",
            "mousedown",
            "mouseup",
            "mousemove",
            "keydown",
            "keyup",
            "keypress",
            "scroll"
        ];
        var play = async function () {
            if (readyToPlay) {
                try {
                    await video.play();
                    if (!video.paused) {
                        eventNames.forEach(function (eventName) {
                            window.removeEventListener(eventName, play, true);
                        });
                    }
                    return video;
                } catch (error) {
                    console.error(error);
                    ARController._teardownVideo(video);
                }
            }
        };
        eventNames.forEach(function (eventName) {
            window.addEventListener(eventName, play, true);
        });

        try {
            const mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: mediaDevicesConstraints
            });

            video.srcObject = mediaStream;
            video.autoplay = true;
        } catch (error) {
            throw "navigator.mediaDevices.getUserMedia failed: " + error;
        }

        return video;
    };

    /**
          ARController.getUserMediaARController gets an ARController for the device camera video feed and calls the
          given onSuccess callback with it.

          To use ARController.getUserMediaARController, call it with an object with the cameraParam attribute set to
          a camera parameter file URL, and the onSuccess attribute set to a callback function.

              ARController.getUserMediaARController({
                  cameraParam: 'Data/camera_para.dat',
                  onSuccess: function(arController, arCameraParam) {
                      console.log("Got ARController", arController);
                      console.log("Got ARCameraParam", arCameraParam);
                      console.log("Got video", arController.image);
                  }
              });

          The configuration object supports the following attributes:

              {
                  cameraParam: url, // URL to camera parameters definition file.
                  maxARVideoSize: number, // Maximum max(width, height) for the AR processing canvas.

                  width : number | {min: number, ideal: number, max: number},
                  height : number | {min: number, ideal: number, max: number},

                  facingMode : 'environment' | 'user' | 'left' | 'right' | { exact: 'environment' | ... }
              }

          See https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia for more information about the
          width, height and facingMode attributes.

          The orientation attribute of the returned ARController is set to "portrait" if the userMedia video has larger
          height than width. Otherwise it's set to "landscape". The videoWidth and videoHeight attributes of the arController
          are set to be always in landscape configuration so that width is larger than height.

          @param {object} configuration The configuration object.
          @return {ARController} Returns the created {@link ARController}.
      */
    ARController.getUserMediaARController = async function (configuration) {
        var obj = {};
        for (var i in configuration) {
            obj[i] = configuration[i];
        }
        var cameraParamURL = configuration.cameraParam;

        const video = await ARController.getUserMedia(obj);

        const arController = new ARController(video, cameraParamURL);
        if (arController.videoWidth < arController.videoHeight) {
            arController.orientation = "portrait";
            const videoWidth = arController.videoWidth;
            arController.videoWidth = arController.videoHeight;
            arController.videoHeight = videoWidth;
        } else {
            arController.orientation = "landscape";
        }
        return arController;
    };

    var _marker_count = 0;
    ARController[_loadTrackable] = async (url) => {
        var filename = "/trackable_" + _marker_count++;
        try {
            await ARController[_ajax](url, filename);
            return filename;
        } catch (e) {
            console.log(e);
            return e;
        }
    }

    var _camera_count = 0;
    ARController[_loadCameraParam] = (url) => {
        return new Promise((resolve, reject) => {
            var filename = "/camera_param_" + _camera_count++;
            if (typeof url === "object" || url.indexOf("\n") > -1) {
                // Maybe it's a byte array
                const target = filename;
                const byteArray = url;
                artoolkitXjs.FS.writeFile(target, byteArray, { encoding: "binary" });
                if (target) resolve(filename);
                else {
                    reject();
                }
            } else {
                ARController[_ajax](url, filename).then(() => resolve(filename)).catch(e => { reject(e) })
            }
        });
    }

    ARController[_loadMultiTrackable] = async (url) => {
        const filename = "/multi_trackable_" + ARController._multi_marker_count++;
        try {
            const bytes = await ARController[_ajax](url, filename);
            let files = ARController[_parseMultiFile](bytes);

            // function ok() {
            //     var markerID = Module._addMultiMarker(arId, filename);
            //     var markerNum = Module.getMultiMarkerNum(arId, markerID);
            //     if (callback) callback(markerID, markerNum);
            // }

            // if (!files.length) return ok();

            const path = url
                .split("/")
                .slice(0, -1)
                .join("/");
            files = files.map(function (file) {
                return [path + "/" + file, file];
            });

            await ARController[_ajaxDependencies](files);
            return filename;
        } catch (error) {
            throw "Error loading multi marker: " + error;
        }
    }

    ARController[_ajaxDependencies] = async (files) => {
        var next = files.pop();
        if (next) {
            await ARController[_ajax](next[0], next[1]);
            await ARController[_ajaxDependencies](files);
        }
    }

    ARController[_parseMultiFile] = (bytes) => {
        const str = String.fromCharCode.apply(String, bytes); // basically bytesToString
        const lines = str.split("\n");
        const files = [];

        let state = 0; // 0 - read,
        let markers = 0;

        lines.forEach(function (line) {
            line = line.trim();
            if (!line || line.startsWith("#")) return; // FIXME: Should probably be `if (line.indexOf('#') === 0) { return; }`

            switch (state) {
                case 0:
                    markers = +line;
                    state = 1;
                    return;
                case 1: // filename or barcode
                    if (!line.match(/^\d+$/)) {
                        files.push(line);
                    }
                case 2: // width
                case 3: // matrices
                case 4:
                    state++;
                    return;
                case 5:
                    state = 1;
                    return;
            }
        });

        return files;
    }
    ARController._marker_count = 0
    ARController._camera_count = 0
    ARController._multi_marker_count = 0;

    /* Exports */
    window.ARController = ARController;
})();

export default ARController;
