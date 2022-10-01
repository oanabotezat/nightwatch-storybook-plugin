module.exports = class RenderStoryCommand {

  get storybookUrl() {
    const pluginSettings = Object.assign({
      start_storybook: false,
      storybook_url: 'http://localhost:6006/'
    }, this.client.settings['@nightwatch/storybook']);

    const storybookUrl = pluginSettings.storybook_url;

    if (this.client.settings.live_url) {
      return `${this.client.settings.live_url}&url=http://localhost:6006`;
    }


    if (storybookUrl.charAt(storybookUrl.length - 1) === '/') {
      return storybookUrl.substring(0, storybookUrl.length - 1);
    }

    return storybookUrl;
  }

  async command(storyId, viewMode, data = {}) {
    const component = await this.api
      .navigateTo(this._getStoryUrl(storyId, viewMode))
      .executeAsyncScript(this._getClientScript(), [{
        baseUrl: this.storybookUrl,
        storyId,
        viewMode
      }], (response) => {
        const result = response.value || {};

        if (result.value === null) {
          throw new Error(
            'Could not render the story. Run nightwatch with --devtools and --debug flags (Chrome only) and investigate the error in the browser console.'
          );
        }

        if (result.value && result.value.name === 'StorybookTestRunnerError') {
          throw new Error(result.value.message);
        }

        this.api.assert.ok(!!result.value, `"${storyId}.${data.exportName}" story was rendered successfully.`);

        const element = this.api.createElement(result.value, {
          isComponent: true
        });
        element.toString = function() {
          return `${storyId}.${data.exportName}`;
        };

        return element;
      });

    if (this.client.argv.debug) {
      await this.api.debug();
    } else if (this.client.argv.preview) {
      await this.api.pause();
    }

    const {a11yConfig} = data;
    if (a11yConfig) {
      await this.api
        .axeInject()
        .axeRun('body', {
          runAssertions: false,
          ...a11yConfig.config
        }, (results) => {
          if (results.error) {
            throw new Error(`Error while running accessibility tests: axeRun(): ${results.error}`);
          }

          const {passes, violations} = results;
          this.client.reporter.setAxeResults({
            passes,
            violations,
            component: `${storyId}.${data.exportName}`
          });
          this.client.reporter.printA11yReport();

          if (results.violations.length > 0) {
            this.api.verify.fail('There are accessibility violations. Please see the complete report for details.');
          }
        });
    }

    return component;
  }

  /**
   * Returned function is going to be executed in the browser,
   * so it will have access to the _window_ object.
   */
  _getClientScript() {
    return function(options, done) {
      let stamp = null;

      const renderedEvent = options.viewMode === 'docs' ? 'docsRendered' : 'storyRendered';

      function waitFor(result) {
        if (result.value === null || result.value.name === 'StorybookTestRunnerError') {
          done(result);

          return;
        }

        if (stamp !== null) {
          clearTimeout(stamp);
        }

        stamp = setTimeout(function() {
          done(result);
        }, 100);
      }

      function StorybookTestRunnerError(errorMessage) {
        const name = 'StorybookTestRunnerError';

        const finalStoryUrl = options.baseUrl + '?path=/story/' + options.storyId + '&addonPanel=storybook/interactions/panel';
        const message = '\nAn error occurred in the following story. Access the link for full output:\n' +
          finalStoryUrl + '\n\nMessage:\n ' + errorMessage;

        return {
          name: name,
          message: message
        };
      }

      // eslint-disable-next-line no-undef
      const channel = window.__STORYBOOK_ADDONS_CHANNEL__;

      if (!channel) {
        throw StorybookTestRunnerError('The test runner could not access the Storybook channel.');
      }

      function getRootChild() {
        // eslint-disable-next-line no-undef
        const root = document.querySelector('#root');

        if (!root) {
          return null;
        }

        return root.firstElementChild;
      }

      channel.on(renderedEvent, function() {
        waitFor({
          event: renderedEvent,
          value: getRootChild()
        });
      });

      channel.on('storyUnchanged', function() {
        waitFor({
          event: 'storyUnchanged',
          value: getRootChild()
        });
      });

      channel.on('storyErrored', function(error) {
        waitFor({
          event: 'storyErrored',
          value: StorybookTestRunnerError(error.description)
        });
      });

      channel.on('storyThrewException', function(error) {
        waitFor({
          event: 'storyThrewException',
          value: StorybookTestRunnerError(error.message)
        });
      });

      channel.on('storyMissing', function(id) {
        if (id === options.storyId) {
          waitFor({
            event: 'storyMissing',
            value: StorybookTestRunnerError('The story was missing when trying to access it.')
          });
        }
      });

      channel.on('playFunctionThrewException', function(error) {
        waitFor({
          event: 'playFunctionThrewException',
          value: StorybookTestRunnerError(error.message)
        });
      });

      channel.emit('forceRemount', {
        storyId: options.storyId,
        viewMode: options.viewMode
      });
    };
  }

  _getStoryUrl(storyId, viewMode) {
    return `${this.storybookUrl}/iframe.html?viewMode=${viewMode}&id=${storyId}`;
  }
};
