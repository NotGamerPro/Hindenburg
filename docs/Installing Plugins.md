# Installing Plugins
The main directory for installing plugins is the `./plugins` directory.

Else, you can use the `HINDENBURG_PLUGINS` environment variable to specify a
custom file location. for plugins.

You can generate a default `plugins` directory with the [`yarn setup`](https://github.com/SkeldJS/Hindenburg/blob/master/docs/Commands.md#yarn-setup) command.

### Installing Plugins from NPM
[`yarn add-plugin <packagename>`](https://github.com/SkeldJS/Hindenburg/blob/master/docs/Commands.md#yarn-add-plugin)
allows you to download Hindenburg plugins that are published on npm and install them easily.

##### Note: Make sure you trust the plugin that you are installing, and that you spell the plugin name correctly.

### Installing Plugins directly
Hindenburg also allows you to install plugins directly into your plugins folder.

You can simply drop the plugin folder or file into your plugins directory and it
will automatically be loaded by Hindenburg.

### Configuring Plugins
You can configure installed plugins via the [`plugins` config option](https://github.com/SkeldJS/Hindenburg/blob/master/docs/Configuration.md#plugins).

## Officially Recognised Plugins
* [hbplugin-customgamecode](https://github.com/SkeldJS/hbplugin-customgamecode) - Allow clients to create games with a custom game code of their choosing.

* [hbplugin-requirehostmods](https://github.com/SkeldJS/hbplugin-requirehostmods) - Require clients joining a room to have the same mods as the host of the room. 