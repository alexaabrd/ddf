/**
 * Copyright (c) Codice Foundation
 *
 * This is free software: you can redistribute it and/or modify it under the terms of the GNU Lesser General Public License as published by the Free Software Foundation, either
 * version 3 of the License, or any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU Lesser General Public License for more details. A copy of the GNU Lesser General Public License is distributed along with this program and can be found at
 * <http://www.gnu.org/licenses/lgpl.html>.
 *
 **/
/*global window*/
define([
        'marionette',
        'backbone',
        'cesium',
        'underscore',
        'wreqr',
        'maptype',
        './notification.view',
        '@turf/turf'
    ],
    function(Marionette, Backbone, Cesium, _, wreqr, maptype, NotificationView, Turf) {
        "use strict";
        var Draw = {};

        var threshold = 8000000;

        function getCurrentMagnitude(view) {
            return view.options.map.camera.getMagnitude();
        }

        // redrawing is expensive, so only do it if necessary (at the threshold)
        function needsRedraw(view){
            var currentMagnitude = getCurrentMagnitude(view);
            if (view.cameraMagnitude < threshold && currentMagnitude > threshold) {
                return true;
            }
            if (view.cameraMagnitude > threshold && currentMagnitude < threshold) {
                return true;
            }
            return false;
        }

        Draw.LineRenderView = Marionette.View.extend({
            cameraMagnitude: undefined,
            animationFrameId: undefined,
            initialize: function() {
                this.updatePrimitive();
                this.listenTo(this.model, 'change:line change:lineWidth', this.updatePrimitive);
                this.listenForCameraChange();
            },
            modelEvents: {
                'changed': 'updatePrimitive'
            },
            updatePrimitive: function() {
                this.drawLine(this.model);
            },
            drawLine: function(model) {
                var linePoints = model.toJSON().line;
                var lineWidth = model.toJSON().lineWidth || 1;
                if (!linePoints) {
                    return;
                }
                var setArr = _.uniq(linePoints);
                if (setArr.length < 2) {
                    return;
                }

                var turfLine = Turf.lineString(setArr);
                var bufferedLine = turfLine;
                this.cameraMagnitude = this.options.map.camera.getMagnitude();
                if (lineWidth > 100 || this.cameraMagnitude < threshold) {
                    bufferedLine = Turf.buffer(turfLine, Math.max(lineWidth, 1), 'meters');
                }

                // first destroy old one
                if (this.primitive && !this.primitive.isDestroyed()) {
                    this.options.map.scene.primitives.remove(this.primitive);
                }

                var color = this.model.get('color');
                this.primitive = new Cesium.PolylineCollection();
                this.primitive.add({
                    width: 8,
                    material: Cesium.Material.fromType('PolylineOutline', {
                        color: color ? Cesium.Color.fromCssColorString(color) : Cesium.Color.KHAKI,
                        outlineColor: Cesium.Color.WHITE,
                        outlineWidth: 4
                    }),
                    id: 'userDrawing',
                    positions: Cesium.Cartesian3.fromDegreesArray(_.flatten(bufferedLine.geometry.coordinates))
                });

                this.options.map.scene.primitives.add(this.primitive);
            },
            destroy: function() {
                this.options.map.scene.camera.moveStart.removeEventListener(this.handleCameraMoveStart, this);
                this.options.map.scene.camera.moveEnd.removeEventListener(this.handleCameraMoveEnd, this);
                window.cancelAnimationFrame(this.animationFrameId);
                if (this.primitive) {
                    this.options.map.scene.primitives.remove(this.primitive);
                }
                this.remove(); // backbone cleanup.
            },
            listenForCameraChange: function() {
                this.options.map.scene.camera.moveStart.addEventListener(this.handleCameraMoveStart, this);
                this.options.map.scene.camera.moveEnd.addEventListener(this.handleCameraMoveEnd, this);
            },
            handleCameraMoveStart: function(){
                this.animationFrameId = window.requestAnimationFrame(function() {
                    if (needsRedraw(this)){
                        this.updatePrimitive();
                    }
                    this.handleCameraMoveStart();
                }.bind(this));
            },
            handleCameraMoveEnd: function(){
                window.cancelAnimationFrame(this.animationFrameId);
                if (needsRedraw(this)) {
                    this.updatePrimitive();
                }
            }
        });

        Draw.Controller = Marionette.Controller.extend({
            enabled: maptype.is3d(),
            initialize: function() {
                this.listenTo(wreqr.vent, 'search:linedisplay', function(model) {
                    if (this.isVisible()) {
                        this.showLine(model);
                    }
                });
                this.listenTo(wreqr.vent, 'search:drawline', function(model) {
                    if (this.isVisible()) {
                        this.draw(model);
                    }
                });
                this.listenTo(wreqr.vent, 'search:drawstop', function(model) {
                    this.stop(model);
                });
                this.listenTo(wreqr.vent, 'search:drawend', function(model) {
                    this.destroy(model);
                });
                this.listenTo(wreqr.vent, 'search:destroyAllDraw', function(model) {
                    this.destroyAll(model);
                });
            },
            views: [],
            isVisible: function() {
                return this.options.map.scene.canvas.width !== 0;
            },
            destroyAll: function() {
                for (var i = this.views.length - 1; i >= 0; i -= 1) {
                    this.destroyView(this.views[i]);
                }
            },
            getViewForModel: function(model) {
                return this.views.filter(function(view) {
                    return view.model === model;
                })[0];
            },
            removeViewForModel: function(model) {
                var view = this.getViewForModel(model);
                if (view) {
                    this.views.splice(this.views.indexOf(view), 1);
                }
            },
            removeView: function(view) {
                this.views.splice(this.views.indexOf(view), 1);
            },
            addView: function(view) {
                this.views.push(view);
            },
            showLine: function(model) {
                if (this.enabled) {
                    this.options.drawHelper.stopDrawing();
                    // remove old line
                    var existingView = this.getViewForModel(model);
                    if (existingView) {
                        existingView.destroy();
                        this.removeViewForModel(model);
                    }
                    var view = new Draw.LineRenderView({ model: model, map: this.options.map });
                    this.addView(view);
                }
            },
            draw: function(model) {
                var controller = this;
                var toDeg = Cesium.Math.toDegrees;
                if (this.enabled) {
                    // start line draw.
                    this.notificationView = new NotificationView({
                        el: this.options.notificationEl
                    }).render();
                    this.options.drawHelper.startDrawingPolyline({
                        callback: function(positions) {

                            if (controller.notificationView) {
                                controller.notificationView.destroy();
                            }
                            var latLonRadPoints = _.map(positions, function(cartPos) {
                                var latLon = controller.options.map.scene.globe.ellipsoid.cartesianToCartographic(cartPos);
                                return [toDeg(latLon.longitude), toDeg(latLon.latitude)];
                            });

                            //this shouldn't ever get hit because the draw library should protect against it, but just in case it does, remove the point
                            if (latLonRadPoints.length > 3 && latLonRadPoints[latLonRadPoints.length - 1][0] === latLonRadPoints[latLonRadPoints.length - 2][0] &&
                                latLonRadPoints[latLonRadPoints.length - 1][1] === latLonRadPoints[latLonRadPoints.length - 2][1]) {
                                latLonRadPoints.pop();
                            }

                            model.set('line', latLonRadPoints);

                            // doing this out of formality since bbox/circle call this after drawing has ended.
                            model.trigger('EndExtent', model);

                            // lets go ahead and show our new shiny line.
                            wreqr.vent.trigger('search:linedisplay', model);
                        }
                    });
                }
            },
            stop: function() {
                if (this.enabled) {
                    // stop drawing
                    this.options.drawHelper.stopDrawing();
                }
                if (this.notificationView) {
                    this.notificationView.destroy();
                }
            },
            destroyView: function(view) {
                view.destroy();
                this.removeView(view);
            },
            destroy: function(model) {
                this.stop();
                var view = this.getViewForModel(model);
                // I don't think we need this method.
                if (this.notificationView) {
                    this.notificationView.destroy();
                }
                if (view) {
                    view.destroy();
                    this.removeViewForModel(model);
                }
            }
        });

        return Draw;
    });