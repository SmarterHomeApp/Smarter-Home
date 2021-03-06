var net = require('net');
var sprintf = require("sprintf-js").sprintf, inherits = require("util").inherits, Promise = require('promise');
var parser = require('xml2json'), libxmljs = require("libxmljs"), sleep = require('sleep');
var extend = require('node.extend'), events = require('events'), util = require('util'), fs = require('fs');
var Accessory, Characteristic, Service, UUIDGen;

module.exports = function (homebridge) {
	Service = homebridge.hap.Service;
	Characteristic = homebridge.hap.Characteristic;
	Accessory = homebridge.platformAccessory;
	UUIDGen = homebridge.hap.uuid;

	inherits(VantageLoad, Accessory);
	process.setMaxListeners(0);
	homebridge.registerPlatform("homebridge-vantage", "VantageControls", VantagePlatform);
};

class VantageInfusion {
    constructor(ipaddress, accessories, usecache) {
		util.inherits(VantageInfusion, events.EventEmitter);
        this.ipaddress = ipaddress;
        this.usecache = usecache || true;
        this.accessories = accessories || [];
        this.command = {};
		this.interfaces = {};
		this.StartCommand();
	}

	/**
	 * Start the command session. The InFusion controller (starting from the 3.2 version of the
	 * firmware) must be configured without encryption or password protection. Support to SSL
	 * and password protected connection will be introduced in the future, the IoT world is
	 * a bad place! 
	 */
	StartCommand() {
		this.command = net.connect({ host: this.ipaddress, port: 3001 }, () => {
			this.command.on('data', (data) => {
				/* Data received */
				var lines = data.toString().split('\n');
				for (var i = 0; i < lines.length; i++) {
					var dataItem = lines[i].split(" ");
					console.log(dataItem);
					if (lines[i].startsWith("S:LOAD ") || lines[i].startsWith("R:GETLOAD ")) {
						/* Live update about load level (even if it's a RGB load') */
						this.emit("loadStatusChange", parseInt(dataItem[1]),parseInt(dataItem[2]));
					}
					if (dataItem[0]=="S:TEMP"){
						//console.log("now lets set the temp!" + parseInt(dataItem[2]));
                                                this.emit(sprintf("thermostatIndoorTemperatureChange"), parseInt(dataItem[2]));
					}
					if (dataItem[0]=="R:INVOKE" && dataItem[3].includes("Thermostat.GetIndoorTemperature")){
						//console.log("lets get the indoor temp!")
                                                this.emit(sprintf("thermostatIndoorTemperatureChange"), parseInt(dataItem[1]),parseFloat(dataItem[2]));
					}
					if (dataItem[0]=="R:GETTHERMOP" || dataItem[0]=='R:THERMTEMP'){
						var modeVal=0;
                                        	if(dataItem[2].includes("OFF"))
                                                	modeVal=0;
                                        	else if(dataItem[2].includes("HEAT"))
                                                	modeVal=1;
                                       		 else if(dataItem[2].includes("COOL"))
                                                	modeVal=2;
                                        	else
                                                	modeVal=3;
						console.log(parseInt(modeVal));
                                                this.emit(sprintf("thermostatIndoorModeChange"), parseInt(dataItem[1]),parseInt(modeVal), parseFloat(dataItem[3]));
                                        }
					/*
					// Outdoor temperature 
					if (lines[i].startsWith("EL: ") && dataItem[3] == "Thermostat.SetOutdoorTemperatureSW")
						this.emit(sprintf("thermostatOutdoorTemperatureChange"), parseInt(dataItem[2]),parseFloat(dataItem[4]/1000));
					if (lines[i].startsWith("R:INVOKE") && dataItem[3] == "Thermostat.GetOutdoorTemperature")
						this.emit(sprintf("thermostatOutdoorTemperatureChange"), parseInt(dataItem[1]),parseFloat(dataItem[2]));
				
					if (lines[i].startsWith("S:TEMP") && dataItem[3] == "Thermostat.SetIndoorTemperatureSW")
						this.emit(sprintf("thermostatIndoorTemperatureChange"), parseInt(dataItem[2]),parseFloat(dataItem[4]/1000));
					*/


					/* Non-state feedback */
					if (lines[i].startsWith("R:INVOKE") && lines[i].indexOf("Object.IsInterfaceSupported")) {
						this.emit(sprintf("isInterfaceSupportedAnswer-%d-%d",parseInt(dataItem[1]),parseInt(dataItem[4])),parseInt(dataItem[2]));
					}
				}
			});			

			this.command.write(sprintf("STATUS ALL\n"));
			this.command.write(sprintf("ELENABLE 1 AUTOMATION ON\nELENABLE 1 EVENT ON\nELENABLE 1 STATUS ON\nELENABLE 1 STATUSEX ON\nELENABLE 1 SYSTEM ON\nELLOG AUTOMATION ON\nELLOG EVENT ON\nELLOG STATUS ON\nELLOG STATUSEX ON\nELLOG SYSTEM ON\n"));
		});
	}

	getLoadStatus(vid) {
		this.command.write(sprintf("GETLOAD %s\n", vid));
	}

	/**
	 * Send the IsInterfaceSupported request to the InFusion controller,
	 * it needs the VID of the object and the IID (InterfaceId) taken 
	 * previously with the configuration session
	 * @return true, false or a promise!
	 */
	isInterfaceSupported(item, interfaceName) {
		if (this.interfaces[interfaceName] === undefined) {
			return new Promise((resolve, reject) => {
				resolve({'item': item, 'interface': interfaceName, 'support':false});
			});
		} else {
			/**
			 * Sample
			 *   OUT| INVOKE 2774 Object.IsInterfaceSupported 32
			 *    IN| R:INVOKE 2774 0 Object.IsInterfaceSupported 32
			 */
			var interfaceId = this.interfaces[interfaceName];
			
			return new Promise((resolve, reject) => {
				this.once(sprintf("isInterfaceSupportedAnswer-%d-%d",parseInt(item.VID),parseInt(interfaceId)), (_support) => {
					resolve({'item': item, 'interface': interfaceName, 'support':_support});
				}
				);
				sleep.usleep(5000);
				this.command.write(sprintf("INVOKE %s Object.IsInterfaceSupported %s\n", item.VID,interfaceId));
			});
		}
	}	

	/**
	 * Start the discovery procedure that use the local cache or download from the InFusion controller
	 * the last configuration saved on the SD card (usually the developer save a backup copy of the configuration
	 * on this support but in some cases it can be different from the current running configuration, I need to
	 * check how to download it with a single pass procedure)
	 */
	Discover() {
		var configuration = net.connect({ host: this.ipaddress, port: 2001 }, () => {
			/**
			 * List interfaces, list configuration and then check if a specific interface 
			 * is supported by the recognized devices. 
			 */

			var buffer = "";
			configuration.on('data', (data) => {
				buffer = buffer + data.toString().replace("\ufeff", "");
				try {
					buffer = buffer.replace('<?File Encode="Base64" /', '<File>');
					buffer = buffer.replace('?>', '</File>');
					libxmljs.parseXml(buffer);
				} catch (e) {
					return false;
				}
				var parsed = JSON.parse(parser.toJson(buffer));
				if (parsed.IIntrospection !== undefined) {
					var interfaces = parsed.IIntrospection.GetInterfaces.return.Interface;
					for (var i = 0; i < interfaces.length; i++) {
						this.interfaces[interfaces[i].Name] = interfaces[i].IID;
					}
				}
				if (parsed.IBackup !== undefined) {
					var xmlconfiguration = Buffer.from(parsed.IBackup.GetFile.return.File, 'base64').toString("ascii"); // Ta-da
					fs.writeFileSync("/tmp/vantage.dc", xmlconfiguration); /* TODO: create a platform-independent temp file */
					this.emit("endDownloadConfiguration", xmlconfiguration);
					configuration.destroy();
				}
				buffer = "";
			});

			/* Aehm, async method becomes sync... */
			configuration.write("<IIntrospection><GetInterfaces><call></call></GetInterfaces></IIntrospection>\n");

			if (fs.existsSync('/tmp/vantage.dc') && this.usecache) {
				fs.readFile('/tmp/vantage.dc', 'utf8', function (err, data) {
					if (!err) {
						this.emit("endDownloadConfiguration", data);
					}
				}.bind(this));
			} else {
				configuration.write("<IBackup><GetFile><call>Backup\\Project.dc</call></GetFile></IBackup>\n");
			}			
		});
	}

	/**
	 * Send the set HSL color request to the controller 
	 */
    RGBLoad_DissolveHSL(vid, h, s, l, time) {
        var thisTime = time || 500;
        this.command.write(sprintf("INVOKE %s RGBLoad.DissolveHSL %s %s %s %s\n", vid, h, s, l * 1000, thisTime))
    }

    Thermostat_GetOutdoorTemperature(vid) {
        this.command.write(sprintf("INVOKE %s Thermostat.GetOutdoorTemperature\n", vid))
    }

    Thermostat_GetIndoorTemperature(vid) {
        this.command.write(sprintf("INVOKE %s Thermostat.GetIndoorTemperature\n", vid))
    }

    Thermostat_SetTargetState(vid,mode){
	if(mode==0)
            this.command.write(sprintf("THERMOP %s OFF\n", vid))
        else if(mode==1)
            this.command.write(sprintf("THERMOP %s HEAT\n", vid))
        else if(mode==2)
            this.command.write(sprintf("THERMOP %s COOL\n", vid))
        else
            this.command.write(sprintf("THERMOP %s AUTO\n", vid))
    }

    Thermostat_GetState(vid) {
       this.command.write(sprintf("GETTHERMOP %s\n", vid))
    }

    Thermostat_GetHeating(vid) {
       this.command.write(sprintf("GETTHERMTEMP %s HEAT\n", vid))
    }

    Thermostat_GetCooling(vid) {
       this.command.write(sprintf("GETTHERMTEMP %s COOL\n", vid))
    }

    Thermostat_SetIndoorTemperature(vid,value,mode) {
	console.log("lets set this shit!!!");
	console.log(mode)
	if(mode==1)
        	this.command.write(sprintf("THERMTEMP %s HEAT %s\n", vid,value))
	else if(mode==2)
		this.command.write(sprintf("THERMTEMP %s COOL %s\n", vid,value))
    }

	/**
	 * Send the set light level to the controller
	 */
    Load_Dim(vid, level, time) {
		// TODO: reduce feedback (or command) rate
		var thisTime = time || 1;
		if (level > 0) {
			this.command.write(sprintf("INVOKE %s Load.Ramp 6 %s %s\n", vid, thisTime, level));
		} else {
			this.command.write(sprintf("INVOKE %s Load.SetLevel %s\n", vid, level));
		}
    }
}


class VantagePlatform {

	constructor(log, config, api) {
		this.log = log;
		this.config = config || {};
		this.api = api;
		this.ipaddress = config.ipaddress;
		this.lastDiscovery = null;
		this.items = [];
		this.infusion = new VantageInfusion(config.ipaddress, this.items, false);
		this.infusion.Discover();
		this.pendingrequests = 0;
		this.ready = false;
		this.callbackPromesedAccessories = undefined;
		this.getAccessoryCallback = null;

		this.log.info("VantagePlatform for InFusion Controller at " + this.ipaddress);

		this.infusion.on('loadStatusChange', (vid,value) => {
			this.items.forEach(function (accessory) {
				if (accessory.address == vid) {
					this.log(sprintf("loadStatusChange (VID=%s, Name=%s, Bri:%d)", vid,accessory.name, value));
					accessory.bri = parseInt(value);
					accessory.power = ((accessory.bri) > 0);
					//console.log(accessory);
					if (accessory.lightBulbService !== undefined) {
						/* Is it ready? */
						accessory.lightBulbService.getCharacteristic(Characteristic.On).getValue(null, accessory.power);
						if (accessory.type == "rgb" || accessory.type == "dimmer") {
							accessory.lightBulbService.getCharacteristic(Characteristic.Brightness).getValue(null, accessory.bri);
						}
					}
				}
			}.bind(this));
		});

		this.infusion.on('thermostatOutdoorTemperatureChange', (vid,value) => {
			this.items.forEach(function (accessory) {
				if (accessory.address == vid) {
					accessory.temperature = parseFloat(value);
					if (accessory.thermostatService !== undefined) {
						/* Is it ready? */
						accessory.thermostatService.getCharacteristic(Characteristic.CurrentTemperature).getValue(null, accessory.temperature);
					}
				}
			}.bind(this));
		});		

		this.infusion.on('thermostatIndoorModeChange', (vid,mode, targetTemp) => {
                        console.log("changing mode");
                        console.log(mode);
			console.log(targetTemp)
                        this.items.forEach(function (accessory) {
                                //console.log(accessory)
                                if (accessory.address == vid) {
                                        accessory.mode = mode;
                                        //console.log(accessory)
                                        if (accessory.thermostatService !== undefined) {
                                                /* Is it ready? */
                                                //console.log(accessory.thermostatService);
                                                accessory.thermostatService.getCharacteristic(Characteristic.CurrentHeatingCoolingState).getValue(null, accessory.mode);
						if(targetTemp !== undefined){
                                                	accessory.targetTemp = targetTemp;
							accessory.thermostatService.getCharacteristic(Characteristic.TargetTemperature).getValue(null, accessory.targetTemp);
                                        	}
					}
                                }
                        }.bind(this));
                });     

		this.infusion.on('thermostatIndoorTemperatureChange', (vid,value) => {
			console.log("indoor thermo?");
			console.log(value);
			this.items.forEach(function (accessory) {
				//console.log(accessory)
				if (accessory.address == vid) {
					accessory.temperature = parseFloat(value);
					//console.log(accessory)
					if (accessory.thermostatService !== undefined) {
						/* Is it ready? */
						//console.log(accessory.thermostatService);
						accessory.thermostatService.getCharacteristic(Characteristic.CurrentTemperature).getValue(null, accessory.temperature);
					}
				}
			}.bind(this));
		});	

		this.infusion.on('endDownloadConfiguration', (configuration) => {
			this.log.debug("VantagePlatform for InFusion Controller (end configuration download)");
			var parsed = JSON.parse(parser.toJson(configuration));
			//this.log("input=    %s",configuration);
			this.log.warn("found vantage now lets add the effing devices");
			for (var i = 0; i < parsed.Project.Objects.Object.length; i++) {
				var thisItemKey = Object.keys(parsed.Project.Objects.Object[i])[0];
				var thisItem = parsed.Project.Objects.Object[i][thisItemKey];
				/*for(var itemID in thisItem){
					this.log.warn(sprintf("Key=%s, Value=%s", itemID, thisItem[itemID]));
				}
				this.log.warn(sprintf("New load asked (VID=%s, Name=%s, Type=%s)", thisItem.VID, thisItem.Name,thisItem.DeviceCategory));
				*/
				if (thisItem.ExcludeFromWidgets === undefined || thisItem.ExcludeFromWidgets == "False" || thisItem.ObjectType == "Thermostat" || thisItem.ObjectType == "Load") {
					if (thisItem.DeviceCategory == "HVAC" || thisItem.ObjectType == "Thermostat") {
						if (thisItem.DName !== undefined && thisItem.DName != "") thisItem.Name = thisItem.DName;
						this.pendingrequests = this.pendingrequests + 1;
						this.log(sprintf("New HVAC added (VID=%s, Name=%s, ---)", thisItem.VID, thisItem.Name));
						//added
						var name="VID"+thisItem.VID+ " " + thisItem.Name
                                                this.items.push(new VantageThermostat(this.log, this, name, thisItem.VID, "thermostat"));
                                                this.pendingrequests = this.pendingrequests - 1;
                                                this.callbackPromesedAccessoriesDo();
						//to here
						/*this.infusion.isInterfaceSupported(thisItem,"Thermostat").then((_response) => {
							if (_response.support) {
								this.log.debug(sprintf("New HVAC added (VID=%s, Name=%s, THERMOSTAT)", _response.item.Name, _response.item.VID));
								this.items.push(new VantageThermostat(this.log, this, _response.item.Name, _response.item.VID, "thermostat"));
								this.pendingrequests = this.pendingrequests - 1;
								this.callbackPromesedAccessoriesDo();
							} else {
								this.pendingrequests = this.pendingrequests - 1;
								this.callbackPromesedAccessoriesDo();
							}
						});*/

					}
					if (thisItem.LoadType == "Incandescent" || thisItem.DeviceCategory == "Lighting") {
						//this.log.warn(sprintf("New light asked (VID=%s, Name=%s, ---)", thisItem.VID, thisItem.Name));
						if (thisItem.DName !== undefined && thisItem.DName != "") thisItem.Name = thisItem.DName;
						this.pendingrequests = this.pendingrequests + 1;
						//this.log(sprintf("New load asked (VID=%s, Name=%s, ---)", thisItem.VID, thisItem.Name));
						//added below
						var name="VID"+thisItem.VID+ " " + thisItem.Name
						this.log(sprintf("New load added (VID=%s, Name=%s, DIMMER)", thisItem.VID, thisItem.Name));
                                                this.items.push(new VantageLoad(this.log, this, name, thisItem.VID, "dimmer"));
                                                this.pendingrequests = this.pendingrequests - 1;
                                                this.callbackPromesedAccessoriesDo();
						//to here
						/*this.infusion.isInterfaceSupported(thisItem,"Load").then((_response) => {
							for(var itemID in _response){
	                                                        this.log.warn(sprintf("_response Key=%s, Value=%s", itemID, _response[itemID]));
                                                        }
							if (_response.interface=="Load"){//_response.support) {
								for(var itemID in _response.item){
                                                                	this.log.warn(sprintf("_response.item Key=%s, Value=%s", itemID, _response.item[itemID]));
                                                        	}
								if (_response.item.PowerProfile !== undefined) {
									// Check if it is a Dimmer or a RGB Load 
									this.infusion.isInterfaceSupported(_response.item,"RGBLoad").then((_response) => {
										for(var itemID in _response){
                                        						this.log.warn(sprintf("_response Key=%s, Value=%s", itemID, _response[itemID]));
                                						}
										if (_response.support) {
											this.log.debug(sprintf("New load added (VID=%s, Name=%s, RGB)", _response.item.Name, _response.item.VID));
											this.items.push(new VantageLoad(this.log, this, _response.item.Name, _response.item.VID, "rgb"));
										} else {
											this.log.debug(sprintf("New load added (VID=%s, Name=%s, DIMMER)", _response.item.Name, _response.item.VID));
											this.items.push(new VantageLoad(this.log, this, _response.item.Name, _response.item.VID, "dimmer"));
										}
										this.pendingrequests = this.pendingrequests - 1;
										this.callbackPromesedAccessoriesDo();
									});
								} else {
									this.log.debug(sprintf("New load added (VID=%s, Name=%s, RELAY)", _response.item.Name, _response.item.VID));
									this.items.push(new VantageLoad(this.log, this, _response.item.Name, _response.item.VID, "relay"));
									this.pendingrequests = this.pendingrequests - 1;
									this.callbackPromesedAccessoriesDo();
								}
							} else {
								//This is not a valid load
								this.pendingrequests = this.pendingrequests - 1;
								this.callbackPromesedAccessoriesDo();
							}
						});*/
					}
				}
			}
			this.log.warn("VantagePlatform for InFusion Controller (end configuration store)");
			this.ready = true;
			this.callbackPromesedAccessoriesDo();
			//console.log("done??");
		});
	}

	/**
	 * Called once, returns the list of accessories only
	 * when the list is complete
	 */
	callbackPromesedAccessoriesDo() {
		if (this.callbackPromesedAccessories !== undefined && this.ready && this.pendingrequests == 0) {
			this.log.warn("VantagePlatform for InFusion Controller (is open for business)");
			//console.log(this.items)
			this.callbackPromesedAccessories(this.items);
		} else {
			this.log.debug(sprintf("VantagePlatform for InFusion Controller (%s,%s)",this.ready,this.pendingrequests));			
		}
	}

	getDevices() {
		return new Promise((resolve, reject) => {
			if (!this.ready) {
				this.log.debug("VantagePlatform for InFusion Controller (wait for getDevices promise)");
				this.callbackPromesedAccessories = resolve;
			} else {
				resolve(this.items);
			}
		});
	}

	/* Get accessory list */
	accessories(callback) {
		this.getDevices().then((devices) => {
			this.log.debug("VantagePlatform for InFusion Controller (accessories readed)");
			callback(devices);
		});
	}
}

class VantageThermostat {
	constructor(log, parent, name, vid, type) {
		this.DisplayName = name;
		this.name = name;
		this.UUID = UUIDGen.generate(vid);
		this.parent = parent;
		this.address = vid;
		this.log = log;
		this.temperature = 0;
		this.targetTemp = 0;
		this.type = type;
		this.heating=0;
		this.cooling=0;
		this.mode=0;  //0=off, 1=heat, 2=cool, 3=auto
		this.units=1;  //0=celcius, 1=f
	}


	getServices() {
		var service = new Service.AccessoryInformation();
		service.setCharacteristic(Characteristic.Name, this.name)
			.setCharacteristic(Characteristic.Manufacturer, "Vantage Controls")
			.setCharacteristic(Characteristic.Model, "Thermostat")
			.setCharacteristic(Characteristic.SerialNumber, "VID " + this.address);

		this.thermostatService = new Service.Thermostat(this.name);
		this.thermostatService.getCharacteristic(Characteristic.CurrentTemperature)
			.on('get', (callback) => {
				this.log(sprintf("getTemperature %s = %.1f",this.address, this.temperature));
				callback(null, this.temperature);
			});


		this.thermostatService.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
                        .on('get', (callback) => {
                                this.log(sprintf("getCurrentState %s = %f",this.address, this.mode));
                                callback(null, this.mode);
                        });

		this.thermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState)
			.on('set', (mode, callback) => {
                                this.mode=mode
                                this.log(sprintf("setTargetHeatingCoolingState %s = %s",this.address,mode));
                                this.parent.infusion.Thermostat_SetTargetState(this.address,this.mode)
                                callback(null);
                        })
                        .on('get', (callback) => {
                                this.log(sprintf("getCurrentState %s = %f",this.address, this.mode));
                                callback(null, this.mode);
                        });



		this.thermostatService.getCharacteristic(Characteristic.HeatingThresholdTemperature)
                        .on('get', (callback) => {
                                this.log(sprintf("getCurrentState %s = %f",this.address, this.heating));
                                callback(null, this.heating);
                        });

		this.thermostatService.getCharacteristic(Characteristic.CoolingThresholdTemperature)
                        .on('get', (callback) => {
                                this.log(sprintf("getCurrentState %s = %f",this.address, this.cooling));
                                callback(null, this.cooling);
                        });

		this.thermostatService.getCharacteristic(Characteristic.TargetTemperature)
                        .on('set', (level, callback) => {
				console.log("lets set this themostat");
				this.targetTemp=parseFloat(level)
                                this.log(sprintf("setTemperature %s = %s and current temp = %f",this.address,level, this.mode));
                                this.parent.infusion.Thermostat_SetIndoorTemperature(this.address,this.targetTemp,this.mode)
                                callback(null);
                        })

                        .on('get', (callback) => {
                                this.log(sprintf("getTargetTemperature %s = %.1f",this.address, this.targetTemp));
                                callback(null, this.targetTemp);
                        });

		this.thermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits)
			.on('set', (units, callback) => {
                                this.units=parseInt(units)
                                this.log(sprintf("getThermoUnit %s = %s",this.address,units));
                                callback(null);
                        })

                        .on('get', (callback) => {
                                this.log(sprintf("getThermoUnits %s = %f",this.address, this.units));
                                callback(null, this.units);
                        });



		this.parent.infusion.Thermostat_GetIndoorTemperature(this.address);
		this.parent.infusion.Thermostat_GetState(this.address);
		if(this.mode==1){
			this.parent.infusion.Thermostat_GetHeating(this.address);
			this.targetTemp=this.heating
		}
		else if (this.mode==2){
			this.parent.infusion.Thermostat_GetCooling(this.address);
			this.targetTemp=this.cooling
		}
		//console.log(service);console.log(this.thermostatService);
		return [service, this.thermostatService];		
	}

}

class VantageLoad {
	constructor(log, parent, name, vid, type) {
		this.displayName = name;
		this.UUID = UUIDGen.generate(vid);
		this.name = name;
		this.parent = parent;
		this.address = vid;
		this.log = log;
		this.bri = 100;
		this.power = false;
		this.sat = 0;
		this.hue = 0;
		this.type = type;
	}

	getServices() {
		var service = new Service.AccessoryInformation();
		service.setCharacteristic(Characteristic.Name, this.name)
			.setCharacteristic(Characteristic.Manufacturer, "Vantage Controls")
			.setCharacteristic(Characteristic.Model, "Power Switch")
			.setCharacteristic(Characteristic.SerialNumber, "VID " + this.address);

		this.lightBulbService = new Service.Lightbulb(this.name);

		//console.log(this.lightBulbService); //here
		this.lightBulbService.getCharacteristic(Characteristic.On)
			.on('set', (level, callback) => {
				this.log.debug(sprintf("setPower %s = %s",this.address, level));
				this.power = (level > 0);
				if (this.power && this.bri == 0) {
					this.bri = 100;
				}
				this.parent.infusion.Load_Dim(this.address, this.power * this.bri);
				callback(null);
			})
			.on('get', (callback) => {
				this.log.debug(sprintf("getPower %s = %s",this.address, this.power));
				callback(null, this.power);
			});

		if (this.type == "dimmer" || this.type == "rgb") {
			this.lightBulbService.getCharacteristic(Characteristic.Brightness)
				.on('set', (level, callback) => {
					this.log(sprintf("setBrightness %s = %d",this.address, level));
					this.bri = parseInt(level);
					this.power = (this.bri > 0);
					this.parent.infusion.Load_Dim(this.address, this.power * this.bri);
					callback(null);
				})
				.on('get', (callback) => {
					//console.log("wtf");
					this.log(sprintf("getBrightness %s = %d",this.address, this.bri));
					callback(null, this.bri);
				});
		}

		if (this.type == "rgb") {
			this.lightBulbService.getCharacteristic(Characteristic.Saturation)
				.on('set', (level, callback) => {
					this.power = true;
					this.sat = level;
					this.parent.infusion.RGBLoad_DissolveHSL(this.address, this.hue, this.sat, this.bri)
					callback(null);
				})
				.on('get', (callback) => {
					callback(null, this.sat);
				});
			this.lightBulbService.getCharacteristic(Characteristic.Hue)
				.on('set', (level, callback) => {
					this.power = true;
					this.hue = level;
					this.parent.infusion.RGBLoad_DissolveHSL(this.address, this.hue, this.sat, this.bri)
					callback(null);
				})
				.on('get', (callback) => {
					callback(null, this.hue);
				});
		}
		//console.log("address is" + this.address);
		//console.log("light service is");console.log( this.lightBulbService);
		//console.log("service is ");console.log(service);
		//console.log(this.UUID);
		this.parent.infusion.getLoadStatus(this.address);
		return [service, this.lightBulbService];
	}
}
