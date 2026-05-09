const key = "AIzaSyDjwBhzpVvLMi8C6I_zkb2wRXafj81Rw1s";
const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`;
fetch(url)
  .then(res => res.json())
  .then(data => {
    if (data.models) {
      console.log("Valid models:");
      data.models.forEach(m => {
        if (m.name.includes("gemini")) {
          console.log(m.name);
        }
      });
    } else {
      console.log("Error:", data);
    }
  })
  .catch(err => console.error(err));
