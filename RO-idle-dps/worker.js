import {attackSkills, previewCharacter, scenarioCatalog, simulate, targets} from "./engine.js";

self.onmessage = ({data: {id, action, snapshot, options}}) => {
  try {
    const result = {
      targets: () => targets,
      skills: () => attackSkills(snapshot),
      scenario: () => scenarioCatalog(snapshot),
      character: () => previewCharacter(snapshot, options),
      simulate: () => simulate(snapshot, options),
    }[action]();
    self.postMessage({id, result});
  } catch (error) {
    self.postMessage({id, error: error.message});
  }
};
