const React = require('react');
const {approvedExternalURL, imdbTitleURL} = require('../platform/ExternalLinks');

function ExternalLink({url, children}) {
  const destination = approvedExternalURL(url);
  if (!destination) return <span>{children}</span>;
  const open = async event => {
    if (event.type === 'auxclick' && event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      const result = await window.mynda.external.open(destination);
      if (!result || result.ok !== true) throw new Error('External link was not opened');
    } catch (_) {
      alert('Mynda could not open this link in your default browser.');
    }
  };
  return <a href={destination} target='_blank' rel='noopener noreferrer'
    title='Open in your default browser' onClick={open} onAuxClick={open}>{children}</a>;
}

function ImdbLink({imdbID, children}) {
  return <ExternalLink url={imdbTitleURL(imdbID)}>{children}</ExternalLink>;
}

module.exports = {ExternalLink, ImdbLink};
